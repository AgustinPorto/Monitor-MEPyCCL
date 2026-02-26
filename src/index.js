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
      "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self' https://dolarito.ar; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

const DASHBOARD_HTML_B64 = `PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVzIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAiPgo8dGl0bGU+UmFkYXIgTUVQL0NDTCDCtyBNZXJjYWRvIEFSRzwvdGl0bGU+CjxsaW5rIHJlbD0icHJlY29ubmVjdCIgaHJlZj0iaHR0cHM6Ly9mb250cy5nb29nbGVhcGlzLmNvbSI+CjxsaW5rIGhyZWY9Imh0dHBzOi8vZm9udHMuZ29vZ2xlYXBpcy5jb20vY3NzMj9mYW1pbHk9U3BhY2UrTW9ubzp3Z2h0QDQwMDs3MDAmZmFtaWx5PVN5bmU6d2dodEA0MDA7NjAwOzcwMDs4MDAmZGlzcGxheT1zd2FwIiByZWw9InN0eWxlc2hlZXQiPgo8c3R5bGU+Ci8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBUT0tFTlMK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCjpyb290IHsKICAtLWJnOiAgICAgICAjMDgwYjBlOwogIC0tc3VyZjogICAgICMwZjEzMTg7CiAgLS1zdXJmMjogICAgIzE2MWIyMjsKICAtLXN1cmYzOiAgICAjMWMyMzMwOwogIC0tYm9yZGVyOiAgICMxZTI1MzA7CiAgLS1ib3JkZXJCOiAgIzJhMzQ0NDsKCiAgLS1ncmVlbjogICAgIzAwZTY3NjsKICAtLWdyZWVuLWQ6ICByZ2JhKDAsMjMwLDExOCwuMDkpOwogIC0tZ3JlZW4tZzogIHJnYmEoMCwyMzAsMTE4LC4yMik7CiAgLS1yZWQ6ICAgICAgI2ZmNDc1NzsKICAtLXJlZC1kOiAgICByZ2JhKDI1NSw3MSw4NywuMDkpOwogIC0teWVsbG93OiAgICNmZmMgYzAwOwogIC0teWVsbG93OiAgICNmZmNjMDA7CiAgLS15ZWxsb3ctZDogcmdiYSgyNTUsMjA0LDAsLjA5KTsKCiAgLS1tZXA6ICAgICAgIzI5YjZmNjsKICAtLWNjbDogICAgICAjYjM5ZGRiOwogIC0tdGV4dDogICAgICNkZGU0ZWU7CiAgLS1tdXRlZDogICAgIzU1NjA3MDsKICAtLW11dGVkMjogICAjN2E4ZmE4OwoKICAtLW1vbm86ICdTcGFjZSBNb25vJywgbW9ub3NwYWNlOwogIC0tc2FuczogJ1N5bmUnLCBzYW5zLXNlcmlmOwoKICAtLWRyYXdlci13OiA0MDBweDsKICAtLWhlYWRlci1oOiA1NHB4Owp9CgoqLCAqOjpiZWZvcmUsICo6OmFmdGVyIHsgYm94LXNpemluZzogYm9yZGVyLWJveDsgbWFyZ2luOiAwOyBwYWRkaW5nOiAwOyB9CgpodG1sIHsgc2Nyb2xsLWJlaGF2aW9yOiBzbW9vdGg7IH0KCmJvZHkgewogIGJhY2tncm91bmQ6IHZhcigtLWJnKTsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgZm9udC1mYW1pbHk6IHZhcigtLW1vbm8pOwogIG1pbi1oZWlnaHQ6IDEwMHZoOwogIG92ZXJmbG93LXg6IGhpZGRlbjsKfQoKYm9keTo6YmVmb3JlIHsKICBjb250ZW50OiAnJzsKICBwb3NpdGlvbjogZml4ZWQ7IGluc2V0OiAwOwogIGJhY2tncm91bmQtaW1hZ2U6CiAgICBsaW5lYXItZ3JhZGllbnQocmdiYSg0MSwxODIsMjQ2LC4wMjUpIDFweCwgdHJhbnNwYXJlbnQgMXB4KSwKICAgIGxpbmVhci1ncmFkaWVudCg5MGRlZywgcmdiYSg0MSwxODIsMjQ2LC4wMjUpIDFweCwgdHJhbnNwYXJlbnQgMXB4KTsKICBiYWNrZ3JvdW5kLXNpemU6IDQ0cHggNDRweDsKICBwb2ludGVyLWV2ZW50czogbm9uZTsgei1pbmRleDogMDsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIExBWU9VVCBTSEVMTArilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLmFwcCB7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBtaW4taGVpZ2h0OiAxMDB2aDsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIEhFQURFUgrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KaGVhZGVyIHsKICBwb3NpdGlvbjogc3RpY2t5OyB0b3A6IDA7IHotaW5kZXg6IDIwMDsKICBoZWlnaHQ6IHZhcigtLWhlYWRlci1oKTsKICBiYWNrZ3JvdW5kOiByZ2JhKDgsMTEsMTQsLjkzKTsKICBiYWNrZHJvcC1maWx0ZXI6IGJsdXIoMThweCk7CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgcGFkZGluZzogMCAyMnB4OwogIGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsKfQoKLmxvZ28gewogIGZvbnQtZmFtaWx5OiB2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6IDgwMDsgZm9udC1zaXplOiAxNXB4OwogIGxldHRlci1zcGFjaW5nOiAuMDVlbTsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA5cHg7Cn0KCi5saXZlLWRvdCB7CiAgd2lkdGg6IDdweDsgaGVpZ2h0OiA3cHg7IGJvcmRlci1yYWRpdXM6IDUwJTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1ncmVlbik7CiAgYm94LXNoYWRvdzogMCAwIDhweCB2YXIoLS1ncmVlbik7CiAgYW5pbWF0aW9uOiBibGluayAyLjJzIGVhc2UtaW4tb3V0IGluZmluaXRlOwp9CkBrZXlmcmFtZXMgYmxpbmsgewogIDAlLDEwMCV7b3BhY2l0eToxO2JveC1zaGFkb3c6MCAwIDhweCB2YXIoLS1ncmVlbik7fQogIDUwJXtvcGFjaXR5Oi4zNTtib3gtc2hhZG93OjAgMCAzcHggdmFyKC0tZ3JlZW4pO30KfQoKLmhlYWRlci1yaWdodCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMTJweDsgfQoKLmZyZXNoLWJhZGdlIHsKICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDVweDsKICBmb250LXNpemU6IDExcHg7IGNvbG9yOiB2YXIoLS1tdXRlZDIpOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYyKTsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOiAyMHB4OyBwYWRkaW5nOiAzcHggMTFweDsKfQouZnJlc2gtZG90IHsgd2lkdGg6NXB4O2hlaWdodDo1cHg7Ym9yZGVyLXJhZGl1czo1MCU7YmFja2dyb3VuZDp2YXIoLS1ncmVlbik7YW5pbWF0aW9uOmJsaW5rIDIuMnMgZWFzZS1pbi1vdXQgaW5maW5pdGU7IH0KLmZyZXNoLWJhZGdlLmZldGNoaW5nIHsgYW5pbWF0aW9uOiBiYWRnZVB1bHNlIDEuMnMgZWFzZS1pbi1vdXQgaW5maW5pdGU7IH0KLmZyZXNoLWJhZGdlLmVycm9yIHsgY29sb3I6I2ZmZDBkMDsgYm9yZGVyLWNvbG9yOnJnYmEoMjU1LDgyLDgyLC40NSk7IGJhY2tncm91bmQ6cmdiYSgyNTUsODIsODIsLjEyKTsgY3Vyc29yOnBvaW50ZXI7IH0KQGtleWZyYW1lcyBiYWRnZVB1bHNlIHsKICAwJSwxMDAlIHsgb3BhY2l0eToxOyB9CiAgNTAlIHsgb3BhY2l0eTouNjU7IH0KfQoKLnRhZy1tZXJjYWRvIHsKICBmb250LWZhbWlseTogdmFyKC0tc2Fucyk7IGZvbnQtc2l6ZToxMHB4OyBmb250LXdlaWdodDo3MDA7CiAgbGV0dGVyLXNwYWNpbmc6LjA4ZW07IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsKICBiYWNrZ3JvdW5kOnZhcigtLWdyZWVuKTsgY29sb3I6IzAwMDsKICBwYWRkaW5nOjNweCA5cHg7IGJvcmRlci1yYWRpdXM6NHB4Owp9Ci50YWctbWVyY2Fkby5jbG9zZWQgeyBiYWNrZ3JvdW5kOnZhcigtLW11dGVkKTsgY29sb3I6IzBhMGMwZjsgfQoKLmJ0biB7CiAgZm9udC1mYW1pbHk6IHZhcigtLXNhbnMpOyBmb250LXNpemU6MTFweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4wN2VtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7CiAgYm9yZGVyLXJhZGl1czo2cHg7IHBhZGRpbmc6NnB4IDE0cHg7IGN1cnNvcjpwb2ludGVyOwogIGJvcmRlcjpub25lOyB0cmFuc2l0aW9uOiBhbGwgLjE4czsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo2cHg7Cn0KLmJ0bi1hbGVydCB7IGJhY2tncm91bmQ6dmFyKC0tZ3JlZW4pOyBjb2xvcjojMDAwOyB9Ci5idG4tYWxlcnQ6aG92ZXIgeyBiYWNrZ3JvdW5kOiMwMGZmODg7IHRyYW5zZm9ybTp0cmFuc2xhdGVZKC0xcHgpOyB9CgouYnRuLXRhc2FzIHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMik7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyQik7CiAgY29sb3I6IHZhcigtLXRleHQpOwp9Ci5idG4tdGFzYXM6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMyk7IGJvcmRlci1jb2xvcjogdmFyKC0tbXV0ZWQyKTsgfQouYnRuLXRhc2FzLmFjdGl2ZSB7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZjMpOwogIGJvcmRlci1jb2xvcjogdmFyKC0teWVsbG93KTsKICBjb2xvcjogdmFyKC0teWVsbG93KTsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIE1BSU4gKyBEUkFXRVIgTEFZT1VUCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwouYm9keS13cmFwIHsKICBmbGV4OiAxOwogIGRpc3BsYXk6IGZsZXg7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIHotaW5kZXg6IDE7CiAgdHJhbnNpdGlvbjogbm9uZTsKfQoKLm1haW4tY29udGVudCB7CiAgZmxleDogMTsKICBtYXgtd2lkdGg6IDEwMCU7CiAgcGFkZGluZzogMjJweCAyMnB4IDYwcHg7CiAgdHJhbnNpdGlvbjogbWFyZ2luLXJpZ2h0IC4zNXMgY3ViaWMtYmV6aWVyKC40LDAsLjIsMSk7Cn0KCi5ib2R5LXdyYXAuZHJhd2VyLW9wZW4gLm1haW4tY29udGVudCB7CiAgbWFyZ2luLXJpZ2h0OiB2YXIoLS1kcmF3ZXItdyk7Cn0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBEUkFXRVIK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5kcmF3ZXIgewogIHBvc2l0aW9uOiBmaXhlZDsKICB0b3A6IHZhcigtLWhlYWRlci1oKTsKICByaWdodDogMDsKICB3aWR0aDogdmFyKC0tZHJhd2VyLXcpOwogIGhlaWdodDogY2FsYygxMDB2aCAtIHZhcigtLWhlYWRlci1oKSk7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZik7CiAgYm9yZGVyLWxlZnQ6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIHRyYW5zZm9ybTogdHJhbnNsYXRlWCgxMDAlKTsKICB0cmFuc2l0aW9uOiB0cmFuc2Zvcm0gLjM1cyBjdWJpYy1iZXppZXIoLjQsMCwuMiwxKTsKICBvdmVyZmxvdy15OiBhdXRvOwogIHotaW5kZXg6IDE1MDsKICBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwp9CgouZHJhd2VyLm9wZW4geyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVgoMCk7IH0KCi5kcmF3ZXItaGVhZGVyIHsKICBwb3NpdGlvbjogc3RpY2t5OyB0b3A6IDA7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZik7CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgcGFkZGluZzogMTZweCAyMHB4OwogIGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsKICB6LWluZGV4OiAxMDsKfQoKLmRyYXdlci10aXRsZSB7CiAgZm9udC1mYW1pbHk6IHZhcigtLXNhbnMpOyBmb250LXdlaWdodDogODAwOyBmb250LXNpemU6IDEzcHg7CiAgbGV0dGVyLXNwYWNpbmc6LjA0ZW07IGNvbG9yOiB2YXIoLS10ZXh0KTsKICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo4cHg7Cn0KCi5kcmF3ZXItc291cmNlIHsKICBmb250LXNpemU6MTBweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBmb250LWZhbWlseTp2YXIoLS1tb25vKTsKfQoKLmJ0bi1jbG9zZSB7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmMik7IGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBjb2xvcjp2YXIoLS1tdXRlZDIpOyBib3JkZXItcmFkaXVzOjZweDsgcGFkZGluZzo1cHggMTBweDsKICBjdXJzb3I6cG9pbnRlcjsgZm9udC1zaXplOjEzcHg7IHRyYW5zaXRpb246IGFsbCAuMTVzOwp9Ci5idG4tY2xvc2U6aG92ZXIgeyBjb2xvcjp2YXIoLS10ZXh0KTsgYm9yZGVyLWNvbG9yOnZhcigtLW11dGVkMik7IH0KCi5kcmF3ZXItYm9keSB7IHBhZGRpbmc6IDE2cHggMjBweDsgZGlzcGxheTogZmxleDsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgZ2FwOiAyMnB4OyB9CgouY29udGV4dC1ib3ggewogIGJhY2tncm91bmQ6IHJnYmEoMjU1LDIwNCwwLC4wNik7CiAgYm9yZGVyOiAxcHggc29saWQgcmdiYSgyNTUsMjA0LDAsLjIpOwogIGJvcmRlci1yYWRpdXM6IDlweDsKICBwYWRkaW5nOiAxM3B4IDE1cHg7CiAgZm9udC1zaXplOiAxMXB4OwogIGxpbmUtaGVpZ2h0OjEuNjU7CiAgY29sb3I6dmFyKC0tbXV0ZWQyKTsKfQouY29udGV4dC1ib3ggc3Ryb25nIHsgY29sb3I6dmFyKC0teWVsbG93KTsgfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIFNUQVRVUyBCQU5ORVIK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5zdGF0dXMtYmFubmVyIHsKICBib3JkZXItcmFkaXVzOjExcHg7IHBhZGRpbmc6MThweCAyNHB4OyBtYXJnaW4tYm90dG9tOjIwcHg7CiAgYm9yZGVyOjFweCBzb2xpZDsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47CiAgYW5pbWF0aW9uOmZhZGVJbiAuNHMgZWFzZTsKICBvdmVyZmxvdzpoaWRkZW47IHBvc2l0aW9uOnJlbGF0aXZlOwp9Ci5zdGF0dXMtYmFubmVyLnNpbWlsYXIgewogIGJhY2tncm91bmQ6dmFyKC0tZ3JlZW4tZCk7IGJvcmRlci1jb2xvcjpyZ2JhKDAsMjMwLDExOCwuMjgpOwp9Ci5zdGF0dXMtYmFubmVyLnNpbWlsYXI6OmFmdGVyIHsKICBjb250ZW50OicnOyBwb3NpdGlvbjphYnNvbHV0ZTsgcmlnaHQ6LTUwcHg7IHRvcDo1MCU7CiAgdHJhbnNmb3JtOnRyYW5zbGF0ZVkoLTUwJSk7IHdpZHRoOjIwMHB4OyBoZWlnaHQ6MjAwcHg7CiAgYm9yZGVyLXJhZGl1czo1MCU7CiAgYmFja2dyb3VuZDpyYWRpYWwtZ3JhZGllbnQoY2lyY2xlLHZhcigtLWdyZWVuLWcpIDAlLHRyYW5zcGFyZW50IDcwJSk7CiAgcG9pbnRlci1ldmVudHM6bm9uZTsKfQouc3RhdHVzLWJhbm5lci5uby1zaW1pbGFyIHsKICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSw4Miw4MiwuMDgpOwogIGJvcmRlci1jb2xvcjogcmdiYSgyNTUsODIsODIsLjM1KTsKfQouc3RhdHVzLWJhbm5lci5uby1zaW1pbGFyOjphZnRlciB7CiAgY29udGVudDonJzsKICBwb3NpdGlvbjphYnNvbHV0ZTsKICByaWdodDotNTBweDsKICB0b3A6NTAlOwogIHRyYW5zZm9ybTp0cmFuc2xhdGVZKC01MCUpOwogIHdpZHRoOjIwMHB4OwogIGhlaWdodDoyMDBweDsKICBib3JkZXItcmFkaXVzOjUwJTsKICBiYWNrZ3JvdW5kOnJhZGlhbC1ncmFkaWVudChjaXJjbGUscmdiYSgyNTUsODIsODIsLjE4KSAwJSx0cmFuc3BhcmVudCA3MCUpOwogIHBvaW50ZXItZXZlbnRzOm5vbmU7Cn0KCi5zLWxlZnQge30KLnMtdGl0bGUgewogIGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXdlaWdodDo4MDA7IGZvbnQtc2l6ZToyNnB4OwogIGxldHRlci1zcGFjaW5nOi0uMDJlbTsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDoxMnB4Owp9Ci5zLWJhZGdlIHsKICBmb250LXNpemU6MTBweDsgZm9udC13ZWlnaHQ6NzAwOyBsZXR0ZXItc3BhY2luZzouMWVtOwogIHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsgcGFkZGluZzoycHggOXB4OyBib3JkZXItcmFkaXVzOjRweDsKICBiYWNrZ3JvdW5kOnZhcigtLWdyZWVuKTsgY29sb3I6IzAwMDsgYWxpZ24tc2VsZjpjZW50ZXI7Cn0KLnMtYmFkZ2Uubm9zaW0geyBiYWNrZ3JvdW5kOiB2YXIoLS1yZWQpOyBjb2xvcjogI2ZmZjsgfQoucy1zdWIgeyBmb250LXNpemU6MTFweDsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgbWFyZ2luLXRvcDo0cHg7IH0KCi5lcnJvci1iYW5uZXIgewogIGRpc3BsYXk6bm9uZTsKICBtYXJnaW46IDAgMCAxNHB4IDA7CiAgcGFkZGluZzogMTBweCAxMnB4OwogIGJvcmRlci1yYWRpdXM6IDhweDsKICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDI1NSw4Miw4MiwuNDUpOwogIGJhY2tncm91bmQ6IHJnYmEoMjU1LDgyLDgyLC4xMik7CiAgY29sb3I6ICNmZmQwZDA7CiAgZm9udC1zaXplOiAxMXB4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuOwogIGdhcDogMTBweDsKfQouZXJyb3ItYmFubmVyLnNob3cgeyBkaXNwbGF5OmZsZXg7IH0KLmVycm9yLWJhbm5lciBidXR0b24gewogIGJvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsODIsODIsLjUpOwogIGJhY2tncm91bmQ6IHJnYmEoMjU1LDgyLDgyLC4xNSk7CiAgY29sb3I6I2ZmZGVkZTsKICBib3JkZXItcmFkaXVzOjZweDsKICBwYWRkaW5nOjRweCAxMHB4OwogIGZvbnQtc2l6ZToxMHB4OwogIGZvbnQtd2VpZ2h0OjcwMDsKICB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7CiAgbGV0dGVyLXNwYWNpbmc6LjA2ZW07CiAgY3Vyc29yOnBvaW50ZXI7Cn0KCi5za2VsZXRvbiB7CiAgYmFja2dyb3VuZDogbGluZWFyLWdyYWRpZW50KDkwZGVnLCAjMWMyMzMwIDI1JSwgIzJhMzQ0NCA1MCUsICMxYzIzMzAgNzUlKTsKICBiYWNrZ3JvdW5kLXNpemU6IDIwMCUgMTAwJTsKICBhbmltYXRpb246IHNoaW1tZXIgMS40cyBpbmZpbml0ZTsKICBib3JkZXItcmFkaXVzOiA0cHg7CiAgY29sb3I6IHRyYW5zcGFyZW50OwogIHVzZXItc2VsZWN0OiBub25lOwp9CkBrZXlmcmFtZXMgc2hpbW1lciB7CiAgMCUgICB7IGJhY2tncm91bmQtcG9zaXRpb246IDIwMCUgMDsgfQogIDEwMCUgeyBiYWNrZ3JvdW5kLXBvc2l0aW9uOiAtMjAwJSAwOyB9Cn0KCi52YWx1ZS1jaGFuZ2VkIHsKICBhbmltYXRpb246IGZsYXNoVmFsdWUgNjAwbXMgZWFzZTsKfQpAa2V5ZnJhbWVzIGZsYXNoVmFsdWUgewogIDAlICAgeyBjb2xvcjogI2ZmY2MwMDsgfQogIDEwMCUgeyBjb2xvcjogaW5oZXJpdDsgfQp9Cgoucy1yaWdodCB7IHRleHQtYWxpZ246cmlnaHQ7IGZvbnQtc2l6ZToxMXB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7IGxpbmUtaGVpZ2h0OjEuOTsgfQoucy1yaWdodCBzdHJvbmcgeyBjb2xvcjp2YXIoLS1tdXRlZDIpOyB9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgSEVSTyBDQVJEUwrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLmhlcm8tZ3JpZCB7CiAgZGlzcGxheTpncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmciAxZnI7CiAgZ2FwOjE0cHg7IG1hcmdpbi1ib3R0b206MjBweDsKfQoKLmhjYXJkIHsKICBiYWNrZ3JvdW5kOnZhcigtLXN1cmYpOyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czoxMXB4OyBwYWRkaW5nOjIwcHggMjJweDsKICBwb3NpdGlvbjpyZWxhdGl2ZTsgb3ZlcmZsb3c6aGlkZGVuOwogIHRyYW5zaXRpb246Ym9yZGVyLWNvbG9yIC4xOHM7CiAgYW5pbWF0aW9uOiBmYWRlVXAgLjVzIGVhc2UgYm90aDsKfQouaGNhcmQ6bnRoLWNoaWxkKDEpe2FuaW1hdGlvbi1kZWxheTouMDhzO30KLmhjYXJkOm50aC1jaGlsZCgyKXthbmltYXRpb24tZGVsYXk6LjE2czt9Ci5oY2FyZDpudGgtY2hpbGQoMyl7YW5pbWF0aW9uLWRlbGF5Oi4yNHM7fQouaGNhcmQ6aG92ZXIgeyBib3JkZXItY29sb3I6dmFyKC0tYm9yZGVyQik7IH0KCi5oY2FyZCAuYmFyIHsgcG9zaXRpb246YWJzb2x1dGU7IHRvcDowO2xlZnQ6MDtyaWdodDowOyBoZWlnaHQ6MnB4OyB9Ci5oY2FyZC5tZXAgLmJhciB7IGJhY2tncm91bmQ6dmFyKC0tbWVwKTsgfQouaGNhcmQuY2NsIC5iYXIgeyBiYWNrZ3JvdW5kOnZhcigtLWNjbCk7IH0KLmhjYXJkLmdhcCAuYmFyIHsgYmFja2dyb3VuZDp2YXIoLS15ZWxsb3cpOyB9CgouaGNhcmQtbGFiZWwgewogIGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXNpemU6MTBweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4xMmVtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7IGNvbG9yOnZhcigtLW11dGVkKTsKICBtYXJnaW4tYm90dG9tOjlweDsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo1cHg7Cn0KLmhjYXJkLWxhYmVsIC5kb3QgeyB3aWR0aDo1cHg7aGVpZ2h0OjVweDtib3JkZXItcmFkaXVzOjUwJTsgfQoubWVwIC5kb3R7YmFja2dyb3VuZDp2YXIoLS1tZXApO30KLmNjbCAuZG90e2JhY2tncm91bmQ6dmFyKC0tY2NsKTt9Ci5nYXAgLmRvdHtiYWNrZ3JvdW5kOnZhcigtLXllbGxvdyk7fQoKLmhjYXJkLXZhbCB7CiAgZm9udC1zaXplOjM0cHg7IGZvbnQtd2VpZ2h0OjcwMDsgbGV0dGVyLXNwYWNpbmc6LS4wMmVtOyBsaW5lLWhlaWdodDoxOwp9Ci5tZXAgLmhjYXJkLXZhbHtjb2xvcjp2YXIoLS1tZXApO30KLmNjbCAuaGNhcmQtdmFse2NvbG9yOnZhcigtLWNjbCk7fQoKLmhjYXJkLXBjdCB7IGZvbnQtc2l6ZToyMHB4OyBjb2xvcjp2YXIoLS15ZWxsb3cpOyBmb250LXdlaWdodDo3MDA7IG1hcmdpbi10b3A6M3B4OyB9Ci5oY2FyZC1zdWIgeyBmb250LXNpemU6MTBweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBtYXJnaW4tdG9wOjdweDsgfQoKLyogdG9vbHRpcCAqLwoudGlwIHsgcG9zaXRpb246cmVsYXRpdmU7IGN1cnNvcjpoZWxwOyB9Ci50aXA6OmFmdGVyIHsKICBjb250ZW50OmF0dHIoZGF0YS10KTsKICBwb3NpdGlvbjphYnNvbHV0ZTsgYm90dG9tOmNhbGMoMTAwJSArIDdweCk7IGxlZnQ6NTAlOwogIHRyYW5zZm9ybTp0cmFuc2xhdGVYKC01MCUpOwogIGJhY2tncm91bmQ6IzFhMjIzMjsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXJCKTsKICBjb2xvcjp2YXIoLS10ZXh0KTsgZm9udC1zaXplOjEwcHg7IHBhZGRpbmc6NXB4IDlweDsKICBib3JkZXItcmFkaXVzOjZweDsgd2hpdGUtc3BhY2U6bm93cmFwOwogIG9wYWNpdHk6MDsgcG9pbnRlci1ldmVudHM6bm9uZTsgdHJhbnNpdGlvbjpvcGFjaXR5IC4xOHM7IHotaW5kZXg6OTk7Cn0KLnRpcDpob3Zlcjo6YWZ0ZXJ7b3BhY2l0eToxO30KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBDSEFSVArilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLmNoYXJ0LWNhcmQgewogIGJhY2tncm91bmQ6dmFyKC0tc3VyZik7IGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOjExcHg7IHBhZGRpbmc6MjJweDsgbWFyZ2luLWJvdHRvbToyMHB4OwogIGFuaW1hdGlvbjpmYWRlVXAgLjVzIC4zMnMgZWFzZSBib3RoOwp9Ci5jaGFydC10b3AgewogIGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjsKICBtYXJnaW4tYm90dG9tOjE2cHg7Cn0KLmNoYXJ0LXR0bCB7IGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXdlaWdodDo3MDA7IGZvbnQtc2l6ZToxM3B4OyB9CgoucGlsbHMgeyBkaXNwbGF5OmZsZXg7IGdhcDo1cHg7IH0KLnBpbGwgewogIGZvbnQtc2l6ZToxMHB4OyBwYWRkaW5nOjNweCAxMXB4OyBib3JkZXItcmFkaXVzOjIwcHg7CiAgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXJCKTsgY29sb3I6dmFyKC0tbXV0ZWQyKTsKICBiYWNrZ3JvdW5kOnRyYW5zcGFyZW50OyBjdXJzb3I6cG9pbnRlcjsgZm9udC1mYW1pbHk6dmFyKC0tbW9ubyk7CiAgdHJhbnNpdGlvbjphbGwgLjEzczsKfQoucGlsbC5vbiB7IGJhY2tncm91bmQ6dmFyKC0tbWVwKTsgYm9yZGVyLWNvbG9yOnZhcigtLW1lcCk7IGNvbG9yOiMwMDA7IGZvbnQtd2VpZ2h0OjcwMDsgfQoKLmxlZ2VuZHMgeyBkaXNwbGF5OmZsZXg7IGdhcDoxOHB4OyBtYXJnaW4tYm90dG9tOjE0cHg7IGZvbnQtc2l6ZToxMHB4OyBjb2xvcjp2YXIoLS1tdXRlZDIpOyB9Ci5sZWcgeyBkaXNwbGF5OmZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsgZ2FwOjVweDsgfQoubGVnLWxpbmUgeyB3aWR0aDoxOHB4OyBoZWlnaHQ6MnB4OyBib3JkZXItcmFkaXVzOjJweDsgfQoKc3ZnLmNoYXJ0IHsgd2lkdGg6MTAwJTsgaGVpZ2h0OjE3MHB4OyBvdmVyZmxvdzp2aXNpYmxlOyB9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgTUVUUklDUwrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLm1ldHJpY3MtZ3JpZCB7CiAgZGlzcGxheTpncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDQsMWZyKTsKICBnYXA6MTJweDsgbWFyZ2luLWJvdHRvbToyMHB4Owp9Ci5tY2FyZCB7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmMik7IGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOjlweDsgcGFkZGluZzoxNHB4IDE2cHg7CiAgYW5pbWF0aW9uOmZhZGVVcCAuNXMgZWFzZSBib3RoOwp9Ci5tY2FyZDpudGgtY2hpbGQoMSl7YW5pbWF0aW9uLWRlbGF5Oi4zOHM7fQoubWNhcmQ6bnRoLWNoaWxkKDIpe2FuaW1hdGlvbi1kZWxheTouNDNzO30KLm1jYXJkOm50aC1jaGlsZCgzKXthbmltYXRpb24tZGVsYXk6LjQ4czt9Ci5tY2FyZDpudGgtY2hpbGQoNCl7YW5pbWF0aW9uLWRlbGF5Oi41M3M7fQoubWNhcmQtbGFiZWwgewogIGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXNpemU6OXB4OyBmb250LXdlaWdodDo3MDA7CiAgbGV0dGVyLXNwYWNpbmc6LjFlbTsgdGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOyBjb2xvcjp2YXIoLS1tdXRlZCk7IG1hcmdpbi1ib3R0b206N3B4Owp9Ci5tY2FyZC12YWwgeyBmb250LXNpemU6MjBweDsgZm9udC13ZWlnaHQ6NzAwOyB9Ci5tY2FyZC1zdWIgeyBmb250LXNpemU6OXB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7IG1hcmdpbi10b3A6M3B4OyB9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgVEFCTEUK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi50YWJsZS1jYXJkIHsKICBiYWNrZ3JvdW5kOnZhcigtLXN1cmYpOyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czoxMXB4OyBvdmVyZmxvdzpoaWRkZW47CiAgYW5pbWF0aW9uOmZhZGVVcCAuNXMgLjU2cyBlYXNlIGJvdGg7Cn0KLnRhYmxlLXRvcCB7CiAgcGFkZGluZzoxNHB4IDIycHg7IGJvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGp1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuOwp9Ci50YWJsZS10dGwgeyBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6NzAwOyBmb250LXNpemU6MTNweDsgfQoudGFibGUtY2FwIHsgZm9udC1zaXplOjEwcHg7IGNvbG9yOnZhcigtLW11dGVkKTsgfQoKLmhpc3RvcnktdGFibGUtd3JhcCB7IG92ZXJmbG93LXg6YXV0bzsgfQouaGlzdG9yeS10YWJsZS13cmFwIHRhYmxlIHsKICBtaW4td2lkdGg6IDg2MHB4Owp9CnRhYmxlIHsgd2lkdGg6MTAwJTsgYm9yZGVyLWNvbGxhcHNlOmNvbGxhcHNlOyB0YWJsZS1sYXlvdXQ6Zml4ZWQ7IH0KdGhlYWQgdGggewogIGZvbnQtc2l6ZTo5cHg7IGxldHRlci1zcGFjaW5nOi4xZW07IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsKICBjb2xvcjp2YXIoLS1tdXRlZCk7IHBhZGRpbmc6OXB4IDIycHg7IHRleHQtYWxpZ246bGVmdDsKICBiYWNrZ3JvdW5kOnZhcigtLXN1cmYyKTsgZm9udC1mYW1pbHk6dmFyKC0tc2Fucyk7IGZvbnQtd2VpZ2h0OjYwMDsKICBwb3NpdGlvbjpyZWxhdGl2ZTsKfQp0Ym9keSB0ciB7IGJvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7IHRyYW5zaXRpb246YmFja2dyb3VuZCAuMTJzOyB9CnRib2R5IHRyOmhvdmVyIHsgYmFja2dyb3VuZDpyZ2JhKDQxLDE4MiwyNDYsLjA0KTsgfQp0Ym9keSB0cjpsYXN0LWNoaWxkIHsgYm9yZGVyLWJvdHRvbTpub25lOyB9CnRib2R5IHRkIHsKICBwYWRkaW5nOjExcHggMjJweDsgZm9udC1zaXplOjEycHg7CiAgb3ZlcmZsb3c6aGlkZGVuOyB0ZXh0LW92ZXJmbG93OmVsbGlwc2lzOyB3aGl0ZS1zcGFjZTpub3dyYXA7Cn0KdGQuZGltIHsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgZm9udC1zaXplOjExcHg7IH0KdGQuZGltIC50cy1kYXkgeyBmb250LXNpemU6OXB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7IGxpbmUtaGVpZ2h0OjEuMTsgfQp0ZC5kaW0gLnRzLWhvdXIgeyBmb250LXNpemU6MTFweDsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgbGluZS1oZWlnaHQ6MS4yOyBtYXJnaW4tdG9wOjJweDsgfQouY29sLWxhYmVsIHsgcGFkZGluZy1yaWdodDoxMHB4OyBkaXNwbGF5OmlubGluZS1ibG9jazsgfQouY29sLXJlc2l6ZXIgewogIHBvc2l0aW9uOmFic29sdXRlOwogIHRvcDowOwogIHJpZ2h0Oi00cHg7CiAgd2lkdGg6OHB4OwogIGhlaWdodDoxMDAlOwogIGN1cnNvcjpjb2wtcmVzaXplOwogIHVzZXItc2VsZWN0Om5vbmU7CiAgdG91Y2gtYWN0aW9uOm5vbmU7CiAgei1pbmRleDoyOwp9Ci5jb2wtcmVzaXplcjo6YWZ0ZXIgewogIGNvbnRlbnQ6Jyc7CiAgcG9zaXRpb246YWJzb2x1dGU7CiAgdG9wOjZweDsKICBib3R0b206NnB4OwogIGxlZnQ6M3B4OwogIHdpZHRoOjFweDsKICBiYWNrZ3JvdW5kOnJnYmEoMTIyLDE0MywxNjgsLjI4KTsKfQouY29sLXJlc2l6ZXI6aG92ZXI6OmFmdGVyLAouY29sLXJlc2l6ZXIuYWN0aXZlOjphZnRlciB7CiAgYmFja2dyb3VuZDpyZ2JhKDEyMiwxNDMsMTY4LC43NSk7Cn0KCi5zYmFkZ2UgewogIGRpc3BsYXk6aW5saW5lLWJsb2NrOyBmb250LXNpemU6OXB4OyBmb250LXdlaWdodDo3MDA7CiAgbGV0dGVyLXNwYWNpbmc6LjA4ZW07IHBhZGRpbmc6MnB4IDdweDsgYm9yZGVyLXJhZGl1czo0cHg7CiAgdGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOwp9Ci5zYmFkZ2Uuc2ltIHsgYmFja2dyb3VuZDp2YXIoLS1ncmVlbi1kKTsgY29sb3I6dmFyKC0tZ3JlZW4pOyBib3JkZXI6MXB4IHNvbGlkIHJnYmEoMCwyMzAsMTE4LC4yKTsgfQouc2JhZGdlLm5vc2ltIHsgYmFja2dyb3VuZDp2YXIoLS1yZWQtZCk7IGNvbG9yOnZhcigtLXJlZCk7IGJvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsNzEsODcsLjIpOyB9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgRk9PVEVSIC8gR0xPU0FSSU8K4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5nbG9zYXJpbyB7CiAgbWFyZ2luLXRvcDoyMHB4OyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czoxMXB4OyBvdmVyZmxvdzpoaWRkZW47CiAgYW5pbWF0aW9uOmZhZGVVcCAuNXMgLjZzIGVhc2UgYm90aDsKfQouZ2xvcy1idG4gewogIHdpZHRoOjEwMCU7IGJhY2tncm91bmQ6dmFyKC0tc3VyZik7IGJvcmRlcjpub25lOwogIGNvbG9yOnZhcigtLW11dGVkMik7IGZvbnQtZmFtaWx5OnZhcigtLW1vbm8pOyBmb250LXNpemU6MTFweDsKICBwYWRkaW5nOjEzcHggMjJweDsgdGV4dC1hbGlnbjpsZWZ0OyBjdXJzb3I6cG9pbnRlcjsKICBkaXNwbGF5OmZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsganVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47CiAgdHJhbnNpdGlvbjpjb2xvciAuMTVzOwp9Ci5nbG9zLWJ0bjpob3ZlciB7IGNvbG9yOnZhcigtLXRleHQpOyB9CgouZ2xvcy1ncmlkIHsKICBkaXNwbGF5Om5vbmU7IGdyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyOwogIGJhY2tncm91bmQ6dmFyKC0tc3VyZjIpOyBib3JkZXItdG9wOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwp9Ci5nbG9zLWdyaWQub3BlbiB7IGRpc3BsYXk6Z3JpZDsgfQoKLmdpIHsKICBwYWRkaW5nOjE0cHggMjJweDsgYm9yZGVyLWJvdHRvbToxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmlnaHQ6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Cn0KLmdpOm50aC1jaGlsZChldmVuKXtib3JkZXItcmlnaHQ6bm9uZTt9Ci5naS10ZXJtIHsKICBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC1zaXplOjEwcHg7IGZvbnQtd2VpZ2h0OjcwMDsKICBsZXR0ZXItc3BhY2luZzouMDhlbTsgdGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOyBjb2xvcjp2YXIoLS1tdXRlZDIpOyBtYXJnaW4tYm90dG9tOjNweDsKfQouZ2ktZGVmIHsgZm9udC1zaXplOjExcHg7IGNvbG9yOnZhcigtLW11dGVkKTsgbGluZS1oZWlnaHQ6MS41OyB9Cgpmb290ZXIgewogIHRleHQtYWxpZ246Y2VudGVyOyBwYWRkaW5nOjIycHg7IGZvbnQtc2l6ZToxMHB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7CiAgYm9yZGVyLXRvcDoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKfQpmb290ZXIgYSB7IGNvbG9yOnZhcigtLW11dGVkMik7IHRleHQtZGVjb3JhdGlvbjpub25lOyB9CmZvb3RlciBhOmhvdmVyIHsgY29sb3I6dmFyKC0tdGV4dCk7IH0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBBTklNQVRJT05TCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwpAa2V5ZnJhbWVzIGZhZGVJbiB7IGZyb217b3BhY2l0eTowO310b3tvcGFjaXR5OjE7fSB9CkBrZXlmcmFtZXMgZmFkZVVwIHsgZnJvbXtvcGFjaXR5OjA7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoMTBweCk7fXRve29wYWNpdHk6MTt0cmFuc2Zvcm06dHJhbnNsYXRlWSgwKTt9IH0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBSRVNQT05TSVZFCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwpAbWVkaWEobWF4LXdpZHRoOjkwMHB4KXsKICA6cm9vdHsgLS1kcmF3ZXItdzogMTAwdnc7IH0KICAuYm9keS13cmFwLmRyYXdlci1vcGVuIC5tYWluLWNvbnRlbnQgeyBtYXJnaW4tcmlnaHQ6MDsgfQogIC5kcmF3ZXIgeyB3aWR0aDoxMDB2dzsgfQp9CkBtZWRpYShtYXgtd2lkdGg6NzAwcHgpewogIC5oZXJvLWdyaWR7IGdyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyOyB9CiAgLmhjYXJkLmdhcHsgZ3JpZC1jb2x1bW46c3BhbiAyOyB9CiAgLm1ldHJpY3MtZ3JpZHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnI7IH0KICAuaGNhcmQtdmFseyBmb250LXNpemU6MjZweDsgfQogIHRoZWFkIHRoOm50aC1jaGlsZCg0KSwgdGJvZHkgdGQ6bnRoLWNoaWxkKDQpeyBkaXNwbGF5Om5vbmU7IH0KICAucy1yaWdodCB7IGRpc3BsYXk6bm9uZTsgfQogIHRkLmRpbSAudHMtZGF5IHsgZm9udC1zaXplOjhweDsgfQogIHRkLmRpbSAudHMtaG91ciB7IGZvbnQtc2l6ZToxMHB4OyB9Cn0KQG1lZGlhKG1heC13aWR0aDo0ODBweCl7CiAgLmhlcm8tZ3JpZHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcjsgfQogIC5oY2FyZC5nYXB7IGdyaWQtY29sdW1uOnNwYW4gMTsgfQogIGhlYWRlcnsgcGFkZGluZzowIDE0cHg7IH0KICAudGFnLW1lcmNhZG97IGRpc3BsYXk6bm9uZTsgfQogIC5idG4tdGFzYXMgc3Bhbi5sYWJlbC1sb25nIHsgZGlzcGxheTpub25lOyB9Cn0KCi8qIERSQVdFUiBPVkVSTEFZIChtb2JpbGUpICovCi5vdmVybGF5IHsKICBkaXNwbGF5Om5vbmU7CiAgcG9zaXRpb246Zml4ZWQ7IGluc2V0OjA7IHotaW5kZXg6MTQwOwogIGJhY2tncm91bmQ6cmdiYSgwLDAsMCwuNTUpOwogIGJhY2tkcm9wLWZpbHRlcjpibHVyKDJweCk7Cn0KQG1lZGlhKG1heC13aWR0aDo5MDBweCl7CiAgLm92ZXJsYXkuc2hvdyB7IGRpc3BsYXk6YmxvY2s7IH0KfQo8L3N0eWxlPgo8L2hlYWQ+Cjxib2R5Pgo8ZGl2IGNsYXNzPSJhcHAiPgoKPCEtLSDilIDilIAgSEVBREVSIOKUgOKUgCAtLT4KPGhlYWRlcj4KICA8ZGl2IGNsYXNzPSJsb2dvIj4KICAgIDxzcGFuIGNsYXNzPSJsaXZlLWRvdCI+PC9zcGFuPgogICAgUkFEQVIgTUVQL0NDTAogIDwvZGl2PgogIDxkaXYgY2xhc3M9ImhlYWRlci1yaWdodCI+CiAgICA8ZGl2IGNsYXNzPSJmcmVzaC1iYWRnZSIgaWQ9ImZyZXNoLWJhZGdlIj4KICAgICAgPHNwYW4gY2xhc3M9ImZyZXNoLWRvdCI+PC9zcGFuPgogICAgICA8c3BhbiBpZD0iZnJlc2gtYmFkZ2UtdGV4dCI+QWN0dWFsaXphbmRv4oCmPC9zcGFuPgogICAgPC9kaXY+CiAgICA8c3BhbiBjbGFzcz0idGFnLW1lcmNhZG8iIGlkPSJ0YWctbWVyY2FkbyI+TWVyY2FkbyBhYmllcnRvPC9zcGFuPgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi10YXNhcyIgaWQ9ImJ0blRhc2FzIiBvbmNsaWNrPSJ0b2dnbGVEcmF3ZXIoKSI+CiAgICAgIPCfk4ogPHNwYW4gY2xhc3M9ImxhYmVsLWxvbmciPlRhc2FzICZhbXA7IEJvbm9zPC9zcGFuPgogICAgPC9idXR0b24+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLWFsZXJ0Ij7wn5SUIEFsZXJ0YXM8L2J1dHRvbj4KICA8L2Rpdj4KPC9oZWFkZXI+Cgo8IS0tIOKUgOKUgCBPVkVSTEFZIChtb2JpbGUpIOKUgOKUgCAtLT4KPGRpdiBjbGFzcz0ib3ZlcmxheSIgaWQ9Im92ZXJsYXkiIG9uY2xpY2s9InRvZ2dsZURyYXdlcigpIj48L2Rpdj4KCjwhLS0g4pSA4pSAIEJPRFkgV1JBUCDilIDilIAgLS0+CjxkaXYgY2xhc3M9ImJvZHktd3JhcCIgaWQ9ImJvZHlXcmFwIj4KCiAgPCEtLSDilZDilZDilZDilZAgTUFJTiDilZDilZDilZDilZAgLS0+CiAgPGRpdiBjbGFzcz0ibWFpbi1jb250ZW50Ij4KCiAgICA8IS0tIFNUQVRVUyBCQU5ORVIgLS0+CiAgICA8ZGl2IGNsYXNzPSJzdGF0dXMtYmFubmVyIHNpbWlsYXIiIGlkPSJzdGF0dXMtYmFubmVyIj4KICAgICAgPGRpdiBjbGFzcz0icy1sZWZ0Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJzLXRpdGxlIj4KICAgICAgICAgIDxzcGFuIGlkPSJzdGF0dXMtbGFiZWwiPk1FUCDiiYggQ0NMPC9zcGFuPgogICAgICAgICAgPHNwYW4gY2xhc3M9InMtYmFkZ2UiIGlkPSJzdGF0dXMtYmFkZ2UiPlNpbWlsYXI8L3NwYW4+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icy1zdWIiPkxhIGJyZWNoYSBlc3TDoSBkZW50cm8gZGVsIHVtYnJhbCDigJQgbG9zIHByZWNpb3Mgc29uIGNvbXBhcmFibGVzPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzLXJpZ2h0Ij4KICAgICAgICA8ZGl2PsOabHRpbWEgY29ycmlkYTogPHN0cm9uZyBpZD0ibGFzdC1ydW4tdGltZSI+4oCUPC9zdHJvbmc+PC9kaXY+CiAgICAgICAgPGRpdiBpZD0iY291bnRkb3duLXRleHQiPlByw7N4aW1hIGFjdHVhbGl6YWNpw7NuIGVuIDU6MDA8L2Rpdj4KICAgICAgICA8ZGl2PkNyb24gR01ULTMgwrcgTHVu4oCTVmllIDEwOjMw4oCTMTg6MDA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImVycm9yLWJhbm5lciIgaWQ9ImVycm9yLWJhbm5lciI+CiAgICAgIDxzcGFuIGlkPSJlcnJvci1iYW5uZXItdGV4dCI+RXJyb3IgYWwgYWN0dWFsaXphciDCtyBSZWludGVudGFyPC9zcGFuPgogICAgICA8YnV0dG9uIGlkPSJlcnJvci1yZXRyeS1idG4iIHR5cGU9ImJ1dHRvbiI+UmVpbnRlbnRhcjwvYnV0dG9uPgogICAgPC9kaXY+CgogICAgPCEtLSBIRVJPIENBUkRTIC0tPgogICAgPGRpdiBjbGFzcz0iaGVyby1ncmlkIj4KICAgICAgPGRpdiBjbGFzcz0iaGNhcmQgbWVwIj4KICAgICAgICA8ZGl2IGNsYXNzPSJiYXIiPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLWxhYmVsIj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJkb3QiPjwvc3Bhbj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0aXAiIGRhdGEtdD0iRMOzbGFyIEJvbHNhIOKAlCBjb21wcmEvdmVudGEgZGUgYm9ub3MgZW4gJEFSUyB5IFVTRCI+TUVQIHZlbnRhIOKTmDwvc3Bhbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC12YWwiIGlkPSJtZXAtdmFsIj4kMS4yNjQ8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC1zdWIiPmRvbGFyaXRvLmFyIMK3IHZlbnRhPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoY2FyZCBjY2wiPgogICAgICAgIDxkaXYgY2xhc3M9ImJhciI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtbGFiZWwiPgogICAgICAgICAgPHNwYW4gY2xhc3M9ImRvdCI+PC9zcGFuPgogICAgICAgICAgPHNwYW4gY2xhc3M9InRpcCIgZGF0YS10PSJDb250YWRvIGNvbiBMaXF1aWRhY2nDs24g4oCUIHNpbWlsYXIgYWwgTUVQIGNvbiBnaXJvIGFsIGV4dGVyaW9yIj5DQ0wgdmVudGEg4pOYPC9zcGFuPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLXZhbCIgaWQ9ImNjbC12YWwiPiQxLjI3MTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLXN1YiI+ZG9sYXJpdG8uYXIgwrcgdmVudGE8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImhjYXJkIGdhcCI+CiAgICAgICAgPGRpdiBjbGFzcz0iYmFyIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC1sYWJlbCI+CiAgICAgICAgICA8c3BhbiBjbGFzcz0iZG90Ij48L3NwYW4+CiAgICAgICAgICA8c3BhbiBjbGFzcz0idGlwIiBkYXRhLXQ9IkJyZWNoYSByZWxhdGl2YSBjb250cmEgZWwgcHJvbWVkaW8gZW50cmUgTUVQIHkgQ0NMIj5CcmVjaGEg4pOYPC9zcGFuPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLXZhbCIgaWQ9ImJyZWNoYS1hYnMiPiQ3PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtcGN0IiBpZD0iYnJlY2hhLXBjdCI+MC41NSU8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC1zdWIiPmRpZmVyZW5jaWEgYWJzb2x1dGEgwrcgcG9yY2VudHVhbDwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAgIDwhLS0gQ0hBUlQgLS0+CiAgICA8ZGl2IGNsYXNzPSJjaGFydC1jYXJkIj4KICAgICAgPGRpdiBjbGFzcz0iY2hhcnQtdG9wIj4KICAgICAgICA8ZGl2IGNsYXNzPSJjaGFydC10dGwiIGlkPSJ0cmVuZC10aXRsZSI+VGVuZGVuY2lhIE1FUC9DQ0wg4oCUIDEgZMOtYTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InBpbGxzIj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9InBpbGwgb24iIGRhdGEtZmlsdGVyPSIxZCI+MSBEw61hPC9idXR0b24+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJwaWxsIiBkYXRhLWZpbHRlcj0iMXciPjEgU2VtYW5hPC9idXR0b24+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJwaWxsIiBkYXRhLWZpbHRlcj0iMW0iPjEgTWVzPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJsZWdlbmRzIj4KICAgICAgICA8ZGl2IGNsYXNzPSJsZWciPjxkaXYgY2xhc3M9ImxlZy1saW5lIiBzdHlsZT0iYmFja2dyb3VuZDp2YXIoLS1tZXApIj48L2Rpdj5NRVA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJsZWciPjxkaXYgY2xhc3M9ImxlZy1saW5lIiBzdHlsZT0iYmFja2dyb3VuZDp2YXIoLS1jY2wpIj48L2Rpdj5DQ0w8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxzdmcgY2xhc3M9ImNoYXJ0IiBpZD0idHJlbmQtY2hhcnQiIHZpZXdCb3g9IjAgMCA4NjAgMTYwIiBwcmVzZXJ2ZUFzcGVjdFJhdGlvPSJub25lIj4KICAgICAgICA8bGluZSB4MT0iMCIgeTE9IjQwIiB4Mj0iODYwIiB5Mj0iNDAiIHN0cm9rZT0iIzFlMjUzMCIgc3Ryb2tlLXdpZHRoPSIxIi8+CiAgICAgICAgPGxpbmUgeDE9IjAiIHkxPSI4MCIgeDI9Ijg2MCIgeTI9IjgwIiBzdHJva2U9IiMxZTI1MzAiIHN0cm9rZS13aWR0aD0iMSIvPgogICAgICAgIDxsaW5lIHgxPSIwIiB5MT0iMTIwIiB4Mj0iODYwIiB5Mj0iMTIwIiBzdHJva2U9IiMxZTI1MzAiIHN0cm9rZS13aWR0aD0iMSIvPgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC15LXRvcCIgeD0iMiIgeT0iMzciIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iOCIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteS1taWQiIHg9IjIiIHk9Ijc3IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjgiIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXktbG93IiB4PSIyIiB5PSIxMTciIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iOCIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICA8cG9seWxpbmUgaWQ9InRyZW5kLW1lcC1saW5lIiBwb2ludHM9IiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMjliNmY2IiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz4KICAgICAgICA8cG9seWxpbmUgaWQ9InRyZW5kLWNjbC1saW5lIiBwb2ludHM9IiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjYjM5ZGRiIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz4KICAgICAgICA8bGluZSBpZD0idHJlbmQtaG92ZXItbGluZSIgeDE9IjAiIHkxPSIxOCIgeDI9IjAiIHkyPSIxMzIiIHN0cm9rZT0iIzJhMzQ0NCIgc3Ryb2tlLXdpZHRoPSIxIiBvcGFjaXR5PSIwIi8+CiAgICAgICAgPGNpcmNsZSBpZD0idHJlbmQtaG92ZXItbWVwIiBjeD0iMCIgY3k9IjAiIHI9IjMuNSIgZmlsbD0iIzI5YjZmNiIgb3BhY2l0eT0iMCIvPgogICAgICAgIDxjaXJjbGUgaWQ9InRyZW5kLWhvdmVyLWNjbCIgY3g9IjAiIGN5PSIwIiByPSIzLjUiIGZpbGw9IiNiMzlkZGIiIG9wYWNpdHk9IjAiLz4KICAgICAgICA8ZyBpZD0idHJlbmQtdG9vbHRpcCIgb3BhY2l0eT0iMCI+CiAgICAgICAgICA8cmVjdCBpZD0idHJlbmQtdG9vbHRpcC1iZyIgeD0iMCIgeT0iMCIgd2lkdGg9IjE0OCIgaGVpZ2h0PSI1NiIgcng9IjYiIGZpbGw9IiMxNjFiMjIiIHN0cm9rZT0iIzJhMzQ0NCIvPgogICAgICAgICAgPHRleHQgaWQ9InRyZW5kLXRpcC10aW1lIiB4PSIxMCIgeT0iMTQiIGZpbGw9IiM1NTYwNzAiIGZvbnQtc2l6ZT0iOCIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC10aXAtbWVwIiB4PSIxMCIgeT0iMjgiIGZpbGw9IiMyOWI2ZjYiIGZvbnQtc2l6ZT0iOSIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPk1FUCDigJQ8L3RleHQ+CiAgICAgICAgICA8dGV4dCBpZD0idHJlbmQtdGlwLWNjbCIgeD0iMTAiIHk9IjQwIiBmaWxsPSIjYjM5ZGRiIiBmb250LXNpemU9IjkiIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj5DQ0wg4oCUPC90ZXh0PgogICAgICAgICAgPHRleHQgaWQ9InRyZW5kLXRpcC1nYXAiIHg9IjEwIiB5PSI1MiIgZmlsbD0iI2ZmY2MwMCIgZm9udC1zaXplPSI4IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+QnJlY2hhIOKAlDwvdGV4dD4KICAgICAgICA8L2c+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXgtMSIgeD0iMjgiIHk9IjE1NCIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI3IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC14LTIiIHg9IjIxOCIgeT0iMTU0IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjciIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXgtMyIgeD0iNDE4IiB5PSIxNTQiIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iNyIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteC00IiB4PSI2MDgiIHk9IjE1NCIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI3IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC14LTUiIHg9Ijc5OCIgeT0iMTU0IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjciIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgIDwvc3ZnPgogICAgPC9kaXY+CgogICAgPCEtLSBNRVRSSUNTIC0tPgogICAgPGRpdiBjbGFzcz0ibWV0cmljcy1ncmlkIj4KICAgICAgPGRpdiBjbGFzcz0ibWNhcmQiPgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLWxhYmVsIiBpZD0ibWV0cmljLWNvdW50LWxhYmVsIj5NdWVzdHJhcyAxIGTDrWE8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC12YWwiIGlkPSJtZXRyaWMtY291bnQtMjRoIj7igJQ8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1zdWIiIGlkPSJtZXRyaWMtY291bnQtc3ViIj5yZWdpc3Ryb3MgZGVsIHBlcsOtb2RvIGZpbHRyYWRvPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJtY2FyZCI+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtbGFiZWwiIGlkPSJtZXRyaWMtc2ltaWxhci1sYWJlbCI+VmVjZXMgc2ltaWxhcjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXZhbCIgc3R5bGU9ImNvbG9yOnZhcigtLWdyZWVuKSIgaWQ9Im1ldHJpYy1zaW1pbGFyLTI0aCI+4oCUPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtc3ViIiBpZD0ibWV0cmljLXNpbWlsYXItc3ViIj5tb21lbnRvcyBlbiB6b25hIOKJpDElIG8g4omkJDEwPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJtY2FyZCI+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtbGFiZWwiIGlkPSJtZXRyaWMtbWluLWxhYmVsIj5CcmVjaGEgbcOtbi48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC12YWwiIGlkPSJtZXRyaWMtbWluLTI0aCI+4oCUPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtc3ViIiBpZD0ibWV0cmljLW1pbi1zdWIiPm3DrW5pbWEgZGVsIHBlcsOtb2RvIGZpbHRyYWRvPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJtY2FyZCI+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtbGFiZWwiIGlkPSJtZXRyaWMtbWF4LWxhYmVsIj5CcmVjaGEgbcOheC48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC12YWwiIHN0eWxlPSJjb2xvcjp2YXIoLS15ZWxsb3cpIiBpZD0ibWV0cmljLW1heC0yNGgiPuKAlDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXN1YiIgaWQ9Im1ldHJpYy1tYXgtc3ViIj5tw6F4aW1hIGRlbCBwZXLDrW9kbyBmaWx0cmFkbzwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAgIDwhLS0gVEFCTEUgLS0+CiAgICA8ZGl2IGNsYXNzPSJ0YWJsZS1jYXJkIj4KICAgICAgPGRpdiBjbGFzcz0idGFibGUtdG9wIj4KICAgICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS10dGwiPkhpc3RvcmlhbCBkZSByZWdpc3Ryb3M8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS1jYXAiIGlkPSJoaXN0b3J5LWNhcCI+w5psdGltYXMg4oCUIG11ZXN0cmFzPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoaXN0b3J5LXRhYmxlLXdyYXAiPgogICAgICA8dGFibGUgaWQ9Imhpc3RvcnktdGFibGUiPgogICAgICAgIDxjb2xncm91cCBpZD0iaGlzdG9yeS1jb2xncm91cCI+CiAgICAgICAgICA8Y29sIGRhdGEtY29sLWluZGV4PSIwIj4KICAgICAgICAgIDxjb2wgZGF0YS1jb2wtaW5kZXg9IjEiPgogICAgICAgICAgPGNvbCBkYXRhLWNvbC1pbmRleD0iMiI+CiAgICAgICAgICA8Y29sIGRhdGEtY29sLWluZGV4PSIzIj4KICAgICAgICAgIDxjb2wgZGF0YS1jb2wtaW5kZXg9IjQiPgogICAgICAgICAgPGNvbCBkYXRhLWNvbC1pbmRleD0iNSI+CiAgICAgICAgPC9jb2xncm91cD4KICAgICAgICA8dGhlYWQ+CiAgICAgICAgICA8dHI+CiAgICAgICAgICAgIDx0aD48c3BhbiBjbGFzcz0iY29sLWxhYmVsIj5Ew61hIC8gSG9yYTwvc3Bhbj48c3BhbiBjbGFzcz0iY29sLXJlc2l6ZXIiIGRhdGEtY29sLWluZGV4PSIwIiByb2xlPSJzZXBhcmF0b3IiIGFyaWEtbGFiZWw9IkFqdXN0YXIgYW5jaG8gZGUgRMOtYSAvIEhvcmEiPjwvc3Bhbj48L3RoPgogICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImNvbC1sYWJlbCI+TUVQPC9zcGFuPjxzcGFuIGNsYXNzPSJjb2wtcmVzaXplciIgZGF0YS1jb2wtaW5kZXg9IjEiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBNRVAiPjwvc3Bhbj48L3RoPgogICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImNvbC1sYWJlbCI+Q0NMPC9zcGFuPjxzcGFuIGNsYXNzPSJjb2wtcmVzaXplciIgZGF0YS1jb2wtaW5kZXg9IjIiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBDQ0wiPjwvc3Bhbj48L3RoPgogICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImNvbC1sYWJlbCI+RGlmICQ8L3NwYW4+PHNwYW4gY2xhc3M9ImNvbC1yZXNpemVyIiBkYXRhLWNvbC1pbmRleD0iMyIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIERpZiAkIj48L3NwYW4+PC90aD4KICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJjb2wtbGFiZWwiPkRpZiAlPC9zcGFuPjxzcGFuIGNsYXNzPSJjb2wtcmVzaXplciIgZGF0YS1jb2wtaW5kZXg9IjQiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBEaWYgJSI+PC9zcGFuPjwvdGg+CiAgICAgICAgICAgIDx0aD48c3BhbiBjbGFzcz0iY29sLWxhYmVsIj5Fc3RhZG88L3NwYW4+PHNwYW4gY2xhc3M9ImNvbC1yZXNpemVyIiBkYXRhLWNvbC1pbmRleD0iNSIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIEVzdGFkbyI+PC9zcGFuPjwvdGg+CiAgICAgICAgICA8L3RyPgogICAgICAgIDwvdGhlYWQ+CiAgICAgICAgPHRib2R5IGlkPSJoaXN0b3J5LXJvd3MiPjwvdGJvZHk+CiAgICAgIDwvdGFibGU+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgPCEtLSBHTE9TQVJJTyAtLT4KICAgIDxkaXYgY2xhc3M9Imdsb3NhcmlvIj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iZ2xvcy1idG4iIG9uY2xpY2s9InRvZ2dsZUdsb3ModGhpcykiPgogICAgICAgIDxzcGFuPvCfk5YgR2xvc2FyaW8gZGUgdMOpcm1pbm9zPC9zcGFuPgogICAgICAgIDxzcGFuIGlkPSJnbG9zQXJyb3ciPuKWvjwvc3Bhbj4KICAgICAgPC9idXR0b24+CiAgICAgIDxkaXYgY2xhc3M9Imdsb3MtZ3JpZCIgaWQ9Imdsb3NHcmlkIj4KICAgICAgICA8ZGl2IGNsYXNzPSJnaSI+PGRpdiBjbGFzcz0iZ2ktdGVybSI+TUVQIHZlbnRhPC9kaXY+PGRpdiBjbGFzcz0iZ2ktZGVmIj5QcmVjaW8gZGUgdmVudGEgZGVsIGTDs2xhciBNRVAgKE1lcmNhZG8gRWxlY3Ryw7NuaWNvIGRlIFBhZ29zKSB2w61hIGNvbXByYS92ZW50YSBkZSBib25vcyBlbiAkQVJTIHkgVVNELjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImdpIj48ZGl2IGNsYXNzPSJnaS10ZXJtIj5DQ0wgdmVudGE8L2Rpdj48ZGl2IGNsYXNzPSJnaS1kZWYiPkNvbnRhZG8gY29uIExpcXVpZGFjacOzbiDigJQgc2ltaWxhciBhbCBNRVAgcGVybyBwZXJtaXRlIHRyYW5zZmVyaXIgZm9uZG9zIGFsIGV4dGVyaW9yLiBTdWVsZSBjb3RpemFyIGxldmVtZW50ZSBwb3IgZW5jaW1hLjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImdpIj48ZGl2IGNsYXNzPSJnaS10ZXJtIj5EaWZlcmVuY2lhICU8L2Rpdj48ZGl2IGNsYXNzPSJnaS1kZWYiPkJyZWNoYSByZWxhdGl2YSBjYWxjdWxhZGEgY29udHJhIGVsIHByb21lZGlvIGVudHJlIE1FUCB5IENDTC4gVW1icmFsIFNJTUlMQVI6IOKJpCAxJSBvIOKJpCAkMTAgQVJTLjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImdpIj48ZGl2IGNsYXNzPSJnaS10ZXJtIj5GcmVzY3VyYSBkZWwgZGF0bzwvZGl2PjxkaXYgY2xhc3M9ImdpLWRlZiI+VGllbXBvIGRlc2RlIGVsIMO6bHRpbW8gdGltZXN0YW1wIGRlIGRvbGFyaXRvLmFyLiBFbCBjcm9uIGNvcnJlIGNhZGEgNSBtaW4gZW4gZMOtYXMgaMOhYmlsZXMuPC9kaXY+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZ2kiPjxkaXYgY2xhc3M9ImdpLXRlcm0iPkVzdGFkbyBTSU1JTEFSPC9kaXY+PGRpdiBjbGFzcz0iZ2ktZGVmIj5DdWFuZG8gTUVQIHkgQ0NMIGVzdMOhbiBkZW50cm8gZGVsIHVtYnJhbCDigJQgbW9tZW50byBpZGVhbCBwYXJhIG9wZXJhciBidXNjYW5kbyBwYXJpZGFkIGVudHJlIGFtYm9zIHRpcG9zLjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImdpIj48ZGl2IGNsYXNzPSJnaS10ZXJtIj5NZXJjYWRvIEFSRzwvZGl2PjxkaXYgY2xhc3M9ImdpLWRlZiI+VmVudGFuYSBvcGVyYXRpdmE6IGx1bmVzIGEgdmllcm5lcyBkZSAxMDozMCBhIDE3OjU5IChHTVQtMywgQnVlbm9zIEFpcmVzKS48L2Rpdj48L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8Zm9vdGVyPgogICAgICBGdWVudGU6IDxhIGhyZWY9IiMiPmRvbGFyaXRvLmFyPC9hPiDCtyA8YSBocmVmPSIjIj5ieW1hLmNvbS5hcjwvYT4gwrcgRGF0b3MgY2FkYSA1IG1pbiBlbiBkw61hcyBow6FiaWxlcyDCtyA8YSBocmVmPSIjIj5SZXBvcnRhciBwcm9ibGVtYTwvYT4KICAgIDwvZm9vdGVyPgoKICA8L2Rpdj48IS0tIC9tYWluLWNvbnRlbnQgLS0+CgogIDwhLS0g4pWQ4pWQ4pWQ4pWQIERSQVdFUiDilZDilZDilZDilZAgLS0+CiAgPGRpdiBjbGFzcz0iZHJhd2VyIiBpZD0iZHJhd2VyIj4KCiAgICA8ZGl2IGNsYXNzPSJkcmF3ZXItaGVhZGVyIj4KICAgICAgPGRpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJkcmF3ZXItdGl0bGUiPvCfk4ogVGFzYXMgJmFtcDsgQm9ub3M8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJkcmF3ZXItc291cmNlIj5GdWVudGVzOiBkb2xhcml0by5hciDCtyBieW1hLmNvbS5hcjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuLWNsb3NlIiBvbmNsaWNrPSJ0b2dnbGVEcmF3ZXIoKSI+4pyVPC9idXR0b24+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJkcmF3ZXItYm9keSI+CiAgICAgIDxkaXYgY2xhc3M9ImNvbnRleHQtYm94Ij4KICAgICAgICA8c3Ryb25nPlByw7N4aW1hbWVudGU8L3N0cm9uZz48YnI+CiAgICAgICAgRXN0YSBzZWNjacOzbiBkZSBUYXNhcyB5IEJvbm9zIHNlIGVuY3VlbnRyYSBlbiByZXZpc2nDs24geSB2b2x2ZXLDoSBlbiB1bmEgcHLDs3hpbWEgdmVyc2nDs24uCiAgICAgIDwvZGl2PgoKICAgIDwvZGl2PjwhLS0gL2RyYXdlci1ib2R5IC0tPgogIDwvZGl2PjwhLS0gL2RyYXdlciAtLT4KCjwvZGl2PjwhLS0gL2JvZHktd3JhcCAtLT4KPC9kaXY+PCEtLSAvYXBwIC0tPgoKPHNjcmlwdD4KICAvLyAxKSBDb25zdGFudGVzIHkgY29uZmlndXJhY2nDs24KICBjb25zdCBFTkRQT0lOVFMgPSB7CiAgICBtZXBDY2w6ICcvYXBpL2RhdGEnCiAgfTsKICBjb25zdCBBUkdfVFogPSAnQW1lcmljYS9BcmdlbnRpbmEvQnVlbm9zX0FpcmVzJzsKICBjb25zdCBGRVRDSF9JTlRFUlZBTF9NUyA9IDMwMDAwMDsKICBjb25zdCBDQUNIRV9LRVkgPSAncmFkYXJfY2FjaGUnOwogIGNvbnN0IEhJU1RPUllfQ09MU19LRVkgPSAncmFkYXJfaGlzdG9yeV9jb2xfd2lkdGhzX3YxJzsKICBjb25zdCBDQUNIRV9UVExfTVMgPSAxNSAqIDYwICogMTAwMDsKICBjb25zdCBSRVRSWV9ERUxBWVMgPSBbMTAwMDAsIDMwMDAwLCA2MDAwMF07CiAgY29uc3QgU0lNSUxBUl9QQ1RfVEhSRVNIT0xEID0gMTsKICBjb25zdCBTSU1JTEFSX0FSU19USFJFU0hPTEQgPSAxMDsKICBjb25zdCBUUkVORF9NQVhfUE9JTlRTID0gMjQwOwogIGNvbnN0IEhJU1RPUllfREVGQVVMVF9DT0xfV0lEVEhTID0gWzE3MCwgMTYwLCAxNjAsIDEyMCwgMTIwLCAxNzBdOwogIGNvbnN0IEhJU1RPUllfTUlOX0NPTF9XSURUSFMgPSBbMTIwLCAxMTAsIDExMCwgOTAsIDkwLCAxMjBdOwogIGNvbnN0IE5VTUVSSUNfSURTID0gWwogICAgJ21lcC12YWwnLCAnY2NsLXZhbCcsICdicmVjaGEtYWJzJywgJ2JyZWNoYS1wY3QnCiAgXTsKICBjb25zdCBzdGF0ZSA9IHsKICAgIHJldHJ5SW5kZXg6IDAsCiAgICByZXRyeVRpbWVyOiBudWxsLAogICAgbGFzdFN1Y2Nlc3NBdDogMCwKICAgIGlzRmV0Y2hpbmc6IGZhbHNlLAogICAgZmlsdGVyTW9kZTogJzFkJywKICAgIGxhc3RNZXBQYXlsb2FkOiBudWxsLAogICAgdHJlbmRSb3dzOiBbXSwKICAgIHRyZW5kSG92ZXJCb3VuZDogZmFsc2UsCiAgICBoaXN0b3J5UmVzaXplQm91bmQ6IGZhbHNlLAogICAgaGlzdG9yeUNvbFdpZHRoczogW10sCiAgICBsYXRlc3Q6IHsKICAgICAgbWVwOiBudWxsLAogICAgICBjY2w6IG51bGwsCiAgICAgIGJyZWNoYUFiczogbnVsbCwKICAgICAgYnJlY2hhUGN0OiBudWxsCiAgICB9CiAgfTsKCiAgLy8gMikgSGVscGVycwogIGNvbnN0IGZtdEFyZ1RpbWUgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZXMtQVInLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgaG91cjogJzItZGlnaXQnLAogICAgbWludXRlOiAnMi1kaWdpdCcKICB9KTsKICBjb25zdCBmbXRBcmdUaW1lU2VjID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VzLUFSJywgewogICAgdGltZVpvbmU6IEFSR19UWiwKICAgIGhvdXI6ICcyLWRpZ2l0JywKICAgIG1pbnV0ZTogJzItZGlnaXQnLAogICAgc2Vjb25kOiAnMi1kaWdpdCcKICB9KTsKICBjb25zdCBmbXRBcmdIb3VyID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VzLUFSJywgewogICAgdGltZVpvbmU6IEFSR19UWiwKICAgIGhvdXI6ICcyLWRpZ2l0JywKICAgIG1pbnV0ZTogJzItZGlnaXQnLAogICAgaG91cjEyOiBmYWxzZQogIH0pOwogIGNvbnN0IGZtdEFyZ0RheU1vbnRoID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VzLUFSJywgewogICAgdGltZVpvbmU6IEFSR19UWiwKICAgIGRheTogJzItZGlnaXQnLAogICAgbW9udGg6ICcyLWRpZ2l0JwogIH0pOwogIGNvbnN0IGZtdEFyZ0RhdGUgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZW4tQ0EnLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgeWVhcjogJ251bWVyaWMnLAogICAgbW9udGg6ICcyLWRpZ2l0JywKICAgIGRheTogJzItZGlnaXQnCiAgfSk7CiAgY29uc3QgZm10QXJnV2Vla2RheSA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlbi1VUycsIHsKICAgIHRpbWVab25lOiBBUkdfVFosCiAgICB3ZWVrZGF5OiAnc2hvcnQnCiAgfSk7CiAgY29uc3QgZm10QXJnUGFydHMgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZW4tVVMnLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgd2Vla2RheTogJ3Nob3J0JywKICAgIGhvdXI6ICcyLWRpZ2l0JywKICAgIG1pbnV0ZTogJzItZGlnaXQnLAogICAgc2Vjb25kOiAnMi1kaWdpdCcsCiAgICBob3VyMTI6IGZhbHNlCiAgfSk7CiAgY29uc3QgV0VFS0RBWSA9IHsgTW9uOiAxLCBUdWU6IDIsIFdlZDogMywgVGh1OiA0LCBGcmk6IDUsIFNhdDogNiwgU3VuOiA3IH07CgogIGZ1bmN0aW9uIHRvTnVtYmVyKHZhbHVlKSB7CiAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpKSByZXR1cm4gdmFsdWU7CiAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykgewogICAgICBjb25zdCBub3JtYWxpemVkID0gdmFsdWUucmVwbGFjZSgvXHMvZywgJycpLnJlcGxhY2UoJywnLCAnLicpLnJlcGxhY2UoL1teXGQuLV0vZywgJycpOwogICAgICBjb25zdCBwYXJzZWQgPSBOdW1iZXIobm9ybWFsaXplZCk7CiAgICAgIHJldHVybiBOdW1iZXIuaXNGaW5pdGUocGFyc2VkKSA/IHBhcnNlZCA6IG51bGw7CiAgICB9CiAgICByZXR1cm4gbnVsbDsKICB9CiAgZnVuY3Rpb24gZ2V0UGF0aChvYmosIHBhdGgpIHsKICAgIHJldHVybiBwYXRoLnJlZHVjZSgoYWNjLCBrZXkpID0+IChhY2MgJiYgYWNjW2tleV0gIT09IHVuZGVmaW5lZCA/IGFjY1trZXldIDogdW5kZWZpbmVkKSwgb2JqKTsKICB9CiAgZnVuY3Rpb24gcGlja051bWJlcihvYmosIHBhdGhzKSB7CiAgICBmb3IgKGNvbnN0IHBhdGggb2YgcGF0aHMpIHsKICAgICAgY29uc3QgdiA9IGdldFBhdGgob2JqLCBwYXRoKTsKICAgICAgY29uc3QgbiA9IHRvTnVtYmVyKHYpOwogICAgICBpZiAobiAhPT0gbnVsbCkgcmV0dXJuIG47CiAgICB9CiAgICByZXR1cm4gbnVsbDsKICB9CiAgZnVuY3Rpb24gcGlja0J5S2V5SGludChvYmosIGhpbnQpIHsKICAgIGlmICghb2JqIHx8IHR5cGVvZiBvYmogIT09ICdvYmplY3QnKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGxvd2VyID0gaGludC50b0xvd2VyQ2FzZSgpOwogICAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXMob2JqKSkgewogICAgICBpZiAoay50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKGxvd2VyKSkgewogICAgICAgIGNvbnN0IG4gPSB0b051bWJlcih2KTsKICAgICAgICBpZiAobiAhPT0gbnVsbCkgcmV0dXJuIG47CiAgICAgICAgaWYgKHYgJiYgdHlwZW9mIHYgPT09ICdvYmplY3QnKSB7CiAgICAgICAgICBjb25zdCBkZWVwID0gcGlja0J5S2V5SGludCh2LCBoaW50KTsKICAgICAgICAgIGlmIChkZWVwICE9PSBudWxsKSByZXR1cm4gZGVlcDsKICAgICAgICB9CiAgICAgIH0KICAgICAgaWYgKHYgJiYgdHlwZW9mIHYgPT09ICdvYmplY3QnKSB7CiAgICAgICAgY29uc3QgZGVlcCA9IHBpY2tCeUtleUhpbnQodiwgaGludCk7CiAgICAgICAgaWYgKGRlZXAgIT09IG51bGwpIHJldHVybiBkZWVwOwogICAgICB9CiAgICB9CiAgICByZXR1cm4gbnVsbDsKICB9CiAgZnVuY3Rpb24gZ2V0QXJnTm93UGFydHMoZGF0ZSA9IG5ldyBEYXRlKCkpIHsKICAgIGNvbnN0IHBhcnRzID0gZm10QXJnUGFydHMuZm9ybWF0VG9QYXJ0cyhkYXRlKS5yZWR1Y2UoKGFjYywgcCkgPT4gewogICAgICBhY2NbcC50eXBlXSA9IHAudmFsdWU7CiAgICAgIHJldHVybiBhY2M7CiAgICB9LCB7fSk7CiAgICByZXR1cm4gewogICAgICB3ZWVrZGF5OiBXRUVLREFZW3BhcnRzLndlZWtkYXldIHx8IDAsCiAgICAgIGhvdXI6IE51bWJlcihwYXJ0cy5ob3VyIHx8ICcwJyksCiAgICAgIG1pbnV0ZTogTnVtYmVyKHBhcnRzLm1pbnV0ZSB8fCAnMCcpLAogICAgICBzZWNvbmQ6IE51bWJlcihwYXJ0cy5zZWNvbmQgfHwgJzAnKQogICAgfTsKICB9CiAgZnVuY3Rpb24gYnJlY2hhUGVyY2VudChtZXAsIGNjbCkgewogICAgaWYgKG1lcCA9PT0gbnVsbCB8fCBjY2wgPT09IG51bGwpIHJldHVybiBudWxsOwogICAgY29uc3QgYXZnID0gKG1lcCArIGNjbCkgLyAyOwogICAgaWYgKCFhdmcpIHJldHVybiBudWxsOwogICAgcmV0dXJuIChNYXRoLmFicyhtZXAgLSBjY2wpIC8gYXZnKSAqIDEwMDsKICB9CiAgZnVuY3Rpb24gZm9ybWF0TW9uZXkodmFsdWUsIGRpZ2l0cyA9IDApIHsKICAgIGlmICh2YWx1ZSA9PT0gbnVsbCkgcmV0dXJuICfigJQnOwogICAgcmV0dXJuICckJyArIHZhbHVlLnRvTG9jYWxlU3RyaW5nKCdlcy1BUicsIHsKICAgICAgbWluaW11bUZyYWN0aW9uRGlnaXRzOiBkaWdpdHMsCiAgICAgIG1heGltdW1GcmFjdGlvbkRpZ2l0czogZGlnaXRzCiAgICB9KTsKICB9CiAgZnVuY3Rpb24gZm9ybWF0UGVyY2VudCh2YWx1ZSwgZGlnaXRzID0gMikgewogICAgaWYgKHZhbHVlID09PSBudWxsKSByZXR1cm4gJ+KAlCc7CiAgICByZXR1cm4gdmFsdWUudG9GaXhlZChkaWdpdHMpICsgJyUnOwogIH0KICBmdW5jdGlvbiBzZXRUZXh0KGlkLCB0ZXh0LCBvcHRpb25zID0ge30pIHsKICAgIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpOwogICAgaWYgKCFlbCkgcmV0dXJuOwogICAgY29uc3QgbmV4dCA9IFN0cmluZyh0ZXh0KTsKICAgIGNvbnN0IHByZXYgPSBlbC50ZXh0Q29udGVudDsKICAgIGVsLnRleHRDb250ZW50ID0gbmV4dDsKICAgIGVsLmNsYXNzTGlzdC5yZW1vdmUoJ3NrZWxldG9uJyk7CiAgICBpZiAob3B0aW9ucy5jaGFuZ2VDbGFzcyAmJiBwcmV2ICE9PSBuZXh0KSB7CiAgICAgIGVsLmNsYXNzTGlzdC5hZGQoJ3ZhbHVlLWNoYW5nZWQnKTsKICAgICAgc2V0VGltZW91dCgoKSA9PiBlbC5jbGFzc0xpc3QucmVtb3ZlKCd2YWx1ZS1jaGFuZ2VkJyksIDYwMCk7CiAgICB9CiAgfQogIGZ1bmN0aW9uIHNldERhc2goaWRzKSB7CiAgICBpZHMuZm9yRWFjaCgoaWQpID0+IHNldFRleHQoaWQsICfigJQnKSk7CiAgfQogIGZ1bmN0aW9uIHNldExvYWRpbmcoaWRzLCBpc0xvYWRpbmcpIHsKICAgIGlkcy5mb3JFYWNoKChpZCkgPT4gewogICAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKTsKICAgICAgaWYgKCFlbCkgcmV0dXJuOwogICAgICBlbC5jbGFzc0xpc3QudG9nZ2xlKCdza2VsZXRvbicsIGlzTG9hZGluZyk7CiAgICB9KTsKICB9CiAgZnVuY3Rpb24gc2V0RnJlc2hCYWRnZSh0ZXh0LCBtb2RlKSB7CiAgICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmcmVzaC1iYWRnZScpOwogICAgY29uc3QgbGFiZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZnJlc2gtYmFkZ2UtdGV4dCcpOwogICAgaWYgKCFiYWRnZSB8fCAhbGFiZWwpIHJldHVybjsKICAgIGxhYmVsLnRleHRDb250ZW50ID0gdGV4dDsKICAgIGJhZGdlLmNsYXNzTGlzdC50b2dnbGUoJ2ZldGNoaW5nJywgbW9kZSA9PT0gJ2ZldGNoaW5nJyk7CiAgICBiYWRnZS5jbGFzc0xpc3QudG9nZ2xlKCdlcnJvcicsIG1vZGUgPT09ICdlcnJvcicpOwogICAgYmFkZ2Uub25jbGljayA9IG1vZGUgPT09ICdlcnJvcicgPyAoKSA9PiBmZXRjaEFsbCh7IG1hbnVhbDogdHJ1ZSB9KSA6IG51bGw7CiAgfQogIGZ1bmN0aW9uIHNldE1hcmtldFRhZyhpc09wZW4pIHsKICAgIGNvbnN0IHRhZyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0YWctbWVyY2FkbycpOwogICAgaWYgKCF0YWcpIHJldHVybjsKICAgIHRhZy50ZXh0Q29udGVudCA9IGlzT3BlbiA/ICdNZXJjYWRvIGFiaWVydG8nIDogJ01lcmNhZG8gY2VycmFkbyc7CiAgICB0YWcuY2xhc3NMaXN0LnRvZ2dsZSgnY2xvc2VkJywgIWlzT3Blbik7CiAgfQogIGZ1bmN0aW9uIHNldEVycm9yQmFubmVyKHNob3csIHRleHQpIHsKICAgIGNvbnN0IGJhbm5lciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdlcnJvci1iYW5uZXInKTsKICAgIGNvbnN0IGxhYmVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Vycm9yLWJhbm5lci10ZXh0Jyk7CiAgICBpZiAoIWJhbm5lcikgcmV0dXJuOwogICAgaWYgKHRleHQgJiYgbGFiZWwpIGxhYmVsLnRleHRDb250ZW50ID0gdGV4dDsKICAgIGJhbm5lci5jbGFzc0xpc3QudG9nZ2xlKCdzaG93JywgISFzaG93KTsKICB9CiAgZnVuY3Rpb24gZXh0cmFjdFJvb3QoanNvbikgewogICAgcmV0dXJuIGpzb24gJiYgdHlwZW9mIGpzb24gPT09ICdvYmplY3QnID8gKGpzb24uZGF0YSB8fCBqc29uLnJlc3VsdCB8fCBqc29uKSA6IHt9OwogIH0KICBmdW5jdGlvbiBnZXRIaXN0b3J5Q29sRWxlbWVudHMoKSB7CiAgICBjb25zdCBjb2xncm91cCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoaXN0b3J5LWNvbGdyb3VwJyk7CiAgICByZXR1cm4gY29sZ3JvdXAgPyBBcnJheS5mcm9tKGNvbGdyb3VwLnF1ZXJ5U2VsZWN0b3JBbGwoJ2NvbCcpKSA6IFtdOwogIH0KICBmdW5jdGlvbiBjbGFtcEhpc3RvcnlXaWR0aHMod2lkdGhzKSB7CiAgICByZXR1cm4gSElTVE9SWV9ERUZBVUxUX0NPTF9XSURUSFMubWFwKChmYWxsYmFjaywgaSkgPT4gewogICAgICBjb25zdCByYXcgPSBOdW1iZXIod2lkdGhzPy5baV0pOwogICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShyYXcpKSByZXR1cm4gZmFsbGJhY2s7CiAgICAgIGNvbnN0IG1pbiA9IEhJU1RPUllfTUlOX0NPTF9XSURUSFNbaV0gPz8gODA7CiAgICAgIHJldHVybiBNYXRoLm1heChtaW4sIE1hdGgucm91bmQocmF3KSk7CiAgICB9KTsKICB9CiAgZnVuY3Rpb24gc2F2ZUhpc3RvcnlDb2x1bW5XaWR0aHMod2lkdGhzKSB7CiAgICB0cnkgewogICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShISVNUT1JZX0NPTFNfS0VZLCBKU09OLnN0cmluZ2lmeShjbGFtcEhpc3RvcnlXaWR0aHMod2lkdGhzKSkpOwogICAgfSBjYXRjaCAoZSkgewogICAgICBjb25zb2xlLmVycm9yKCdbUmFkYXJNRVBdIG5vIHNlIHB1ZG8gZ3VhcmRhciBhbmNob3MgZGUgY29sdW1uYXMnLCBlKTsKICAgIH0KICB9CiAgZnVuY3Rpb24gbG9hZEhpc3RvcnlDb2x1bW5XaWR0aHMoKSB7CiAgICB0cnkgewogICAgICBjb25zdCByYXcgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShISVNUT1JZX0NPTFNfS0VZKTsKICAgICAgaWYgKCFyYXcpIHJldHVybiBudWxsOwogICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdyk7CiAgICAgIGlmICghQXJyYXkuaXNBcnJheShwYXJzZWQpIHx8IHBhcnNlZC5sZW5ndGggIT09IEhJU1RPUllfREVGQVVMVF9DT0xfV0lEVEhTLmxlbmd0aCkgcmV0dXJuIG51bGw7CiAgICAgIHJldHVybiBjbGFtcEhpc3RvcnlXaWR0aHMocGFyc2VkKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgY29uc29sZS5lcnJvcignW1JhZGFyTUVQXSBhbmNob3MgZGUgY29sdW1uYXMgaW52w6FsaWRvcycsIGUpOwogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICB9CiAgZnVuY3Rpb24gYXBwbHlIaXN0b3J5Q29sdW1uV2lkdGhzKHdpZHRocywgcGVyc2lzdCA9IGZhbHNlKSB7CiAgICBjb25zdCBjb2xzID0gZ2V0SGlzdG9yeUNvbEVsZW1lbnRzKCk7CiAgICBpZiAoY29scy5sZW5ndGggIT09IEhJU1RPUllfREVGQVVMVF9DT0xfV0lEVEhTLmxlbmd0aCkgcmV0dXJuOwogICAgY29uc3QgbmV4dCA9IGNsYW1wSGlzdG9yeVdpZHRocyh3aWR0aHMpOwogICAgY29scy5mb3JFYWNoKChjb2wsIGkpID0+IHsKICAgICAgY29sLnN0eWxlLndpZHRoID0gYCR7bmV4dFtpXX1weGA7CiAgICB9KTsKICAgIHN0YXRlLmhpc3RvcnlDb2xXaWR0aHMgPSBuZXh0OwogICAgaWYgKHBlcnNpc3QpIHNhdmVIaXN0b3J5Q29sdW1uV2lkdGhzKG5leHQpOwogIH0KICBmdW5jdGlvbiBpbml0SGlzdG9yeUNvbHVtbldpZHRocygpIHsKICAgIGNvbnN0IHNhdmVkID0gbG9hZEhpc3RvcnlDb2x1bW5XaWR0aHMoKTsKICAgIGFwcGx5SGlzdG9yeUNvbHVtbldpZHRocyhzYXZlZCB8fCBISVNUT1JZX0RFRkFVTFRfQ09MX1dJRFRIUywgZmFsc2UpOwogIH0KICBmdW5jdGlvbiBiaW5kSGlzdG9yeUNvbHVtblJlc2l6ZSgpIHsKICAgIGlmIChzdGF0ZS5oaXN0b3J5UmVzaXplQm91bmQpIHJldHVybjsKICAgIGNvbnN0IHRhYmxlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hpc3RvcnktdGFibGUnKTsKICAgIGlmICghdGFibGUpIHJldHVybjsKICAgIGNvbnN0IGhhbmRsZXMgPSBBcnJheS5mcm9tKHRhYmxlLnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb2wtcmVzaXplcicpKTsKICAgIGlmICghaGFuZGxlcy5sZW5ndGgpIHJldHVybjsKICAgIHN0YXRlLmhpc3RvcnlSZXNpemVCb3VuZCA9IHRydWU7CgogICAgaGFuZGxlcy5mb3JFYWNoKChoYW5kbGUpID0+IHsKICAgICAgaGFuZGxlLmFkZEV2ZW50TGlzdGVuZXIoJ2RibGNsaWNrJywgKGV2ZW50KSA9PiB7CiAgICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTsKICAgICAgICBjb25zdCBpZHggPSBOdW1iZXIoaGFuZGxlLmRhdGFzZXQuY29sSW5kZXgpOwogICAgICAgIGlmICghTnVtYmVyLmlzRmluaXRlKGlkeCkpIHJldHVybjsKICAgICAgICBjb25zdCBuZXh0ID0gc3RhdGUuaGlzdG9yeUNvbFdpZHRocy5zbGljZSgpOwogICAgICAgIG5leHRbaWR4XSA9IEhJU1RPUllfREVGQVVMVF9DT0xfV0lEVEhTW2lkeF07CiAgICAgICAgYXBwbHlIaXN0b3J5Q29sdW1uV2lkdGhzKG5leHQsIHRydWUpOwogICAgICB9KTsKICAgICAgaGFuZGxlLmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJkb3duJywgKGV2ZW50KSA9PiB7CiAgICAgICAgaWYgKGV2ZW50LmJ1dHRvbiAhPT0gMCkgcmV0dXJuOwogICAgICAgIGNvbnN0IGlkeCA9IE51bWJlcihoYW5kbGUuZGF0YXNldC5jb2xJbmRleCk7CiAgICAgICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoaWR4KSkgcmV0dXJuOwogICAgICAgIGNvbnN0IHN0YXJ0WCA9IGV2ZW50LmNsaWVudFg7CiAgICAgICAgY29uc3Qgc3RhcnRXaWR0aCA9IHN0YXRlLmhpc3RvcnlDb2xXaWR0aHNbaWR4XSA/PyBISVNUT1JZX0RFRkFVTFRfQ09MX1dJRFRIU1tpZHhdOwogICAgICAgIGhhbmRsZS5jbGFzc0xpc3QuYWRkKCdhY3RpdmUnKTsKICAgICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpOwoKICAgICAgICBjb25zdCBvbk1vdmUgPSAobW92ZUV2ZW50KSA9PiB7CiAgICAgICAgICBjb25zdCBkZWx0YSA9IG1vdmVFdmVudC5jbGllbnRYIC0gc3RhcnRYOwogICAgICAgICAgY29uc3QgbWluID0gSElTVE9SWV9NSU5fQ09MX1dJRFRIU1tpZHhdID8/IDgwOwogICAgICAgICAgY29uc3QgbmV4dFdpZHRoID0gTWF0aC5tYXgobWluLCBNYXRoLnJvdW5kKHN0YXJ0V2lkdGggKyBkZWx0YSkpOwogICAgICAgICAgY29uc3QgbmV4dCA9IHN0YXRlLmhpc3RvcnlDb2xXaWR0aHMuc2xpY2UoKTsKICAgICAgICAgIG5leHRbaWR4XSA9IG5leHRXaWR0aDsKICAgICAgICAgIGFwcGx5SGlzdG9yeUNvbHVtbldpZHRocyhuZXh0LCBmYWxzZSk7CiAgICAgICAgfTsKICAgICAgICBjb25zdCBvblVwID0gKCkgPT4gewogICAgICAgICAgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJtb3ZlJywgb25Nb3ZlKTsKICAgICAgICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKCdwb2ludGVydXAnLCBvblVwKTsKICAgICAgICAgIGhhbmRsZS5jbGFzc0xpc3QucmVtb3ZlKCdhY3RpdmUnKTsKICAgICAgICAgIHNhdmVIaXN0b3J5Q29sdW1uV2lkdGhzKHN0YXRlLmhpc3RvcnlDb2xXaWR0aHMpOwogICAgICAgIH07CiAgICAgICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJtb3ZlJywgb25Nb3ZlKTsKICAgICAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigncG9pbnRlcnVwJywgb25VcCk7CiAgICAgIH0pOwogICAgfSk7CiAgfQoKICAvLyAzKSBGdW5jaW9uZXMgZGUgcmVuZGVyCiAgZnVuY3Rpb24gcmVuZGVyTWVwQ2NsKHBheWxvYWQpIHsKICAgIGlmICghcGF5bG9hZCkgewogICAgICBzZXREYXNoKFsnbWVwLXZhbCcsICdjY2wtdmFsJywgJ2JyZWNoYS1hYnMnLCAnYnJlY2hhLXBjdCddKTsKICAgICAgc2V0VGV4dCgnc3RhdHVzLWxhYmVsJywgJ0RhdG9zIGluY29tcGxldG9zJyk7CiAgICAgIHNldFRleHQoJ3N0YXR1cy1iYWRnZScsICdTaW4gZGF0bycpOwogICAgICByZXR1cm47CiAgICB9CiAgICBjb25zdCBkYXRhID0gZXh0cmFjdFJvb3QocGF5bG9hZCk7CiAgICBjb25zdCBjdXJyZW50ID0gZGF0YSAmJiB0eXBlb2YgZGF0YS5jdXJyZW50ID09PSAnb2JqZWN0JyA/IGRhdGEuY3VycmVudCA6IG51bGw7CiAgICBjb25zdCBtZXAgPSBjdXJyZW50ID8gdG9OdW1iZXIoY3VycmVudC5tZXApIDogKHBpY2tOdW1iZXIoZGF0YSwgW1snbWVwJywgJ3ZlbnRhJ10sIFsnbWVwJywgJ3NlbGwnXSwgWydtZXAnXSwgWydtZXBfdmVudGEnXSwgWydkb2xhcl9tZXAnXV0pID8/IHBpY2tCeUtleUhpbnQoZGF0YSwgJ21lcCcpKTsKICAgIGNvbnN0IGNjbCA9IGN1cnJlbnQgPyB0b051bWJlcihjdXJyZW50LmNjbCkgOiAocGlja051bWJlcihkYXRhLCBbWydjY2wnLCAndmVudGEnXSwgWydjY2wnLCAnc2VsbCddLCBbJ2NjbCddLCBbJ2NjbF92ZW50YSddLCBbJ2RvbGFyX2NjbCddXSkgPz8gcGlja0J5S2V5SGludChkYXRhLCAnY2NsJykpOwogICAgY29uc3QgYWJzID0gY3VycmVudCA/IHRvTnVtYmVyKGN1cnJlbnQuYWJzRGlmZikgPz8gKG1lcCAhPT0gbnVsbCAmJiBjY2wgIT09IG51bGwgPyBNYXRoLmFicyhtZXAgLSBjY2wpIDogbnVsbCkgOiAobWVwICE9PSBudWxsICYmIGNjbCAhPT0gbnVsbCA/IE1hdGguYWJzKG1lcCAtIGNjbCkgOiBudWxsKTsKICAgIGNvbnN0IHBjdCA9IGN1cnJlbnQgPyB0b051bWJlcihjdXJyZW50LnBjdERpZmYpID8/IGJyZWNoYVBlcmNlbnQobWVwLCBjY2wpIDogYnJlY2hhUGVyY2VudChtZXAsIGNjbCk7CiAgICBjb25zdCBpc1NpbWlsYXIgPSBjdXJyZW50ICYmIHR5cGVvZiBjdXJyZW50LnNpbWlsYXIgPT09ICdib29sZWFuJwogICAgICA/IGN1cnJlbnQuc2ltaWxhcgogICAgICA6IChwY3QgIT09IG51bGwgJiYgYWJzICE9PSBudWxsICYmIChwY3QgPD0gU0lNSUxBUl9QQ1RfVEhSRVNIT0xEIHx8IGFicyA8PSBTSU1JTEFSX0FSU19USFJFU0hPTEQpKTsKCiAgICBzZXRUZXh0KCdtZXAtdmFsJywgZm9ybWF0TW9uZXkobWVwLCAyKSwgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ2NjbC12YWwnLCBmb3JtYXRNb25leShjY2wsIDIpLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc2V0VGV4dCgnYnJlY2hhLWFicycsIGFicyA9PT0gbnVsbCA/ICfigJQnIDogZm9ybWF0TW9uZXkoYWJzLCAyKSwgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ2JyZWNoYS1wY3QnLCBmb3JtYXRQZXJjZW50KHBjdCwgMiksIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdzdGF0dXMtbGFiZWwnLCBpc1NpbWlsYXIgPyAnTUVQIOKJiCBDQ0wnIDogJ01FUCDiiaAgQ0NMJyk7CiAgICBzZXRUZXh0KCdzdGF0dXMtYmFkZ2UnLCBpc1NpbWlsYXIgPyAnU2ltaWxhcicgOiAnTm8gc2ltaWxhcicpOwogICAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3RhdHVzLWJhZGdlJyk7CiAgICBpZiAoYmFkZ2UpIGJhZGdlLmNsYXNzTGlzdC50b2dnbGUoJ25vc2ltJywgIWlzU2ltaWxhcik7CgogICAgY29uc3QgYmFubmVyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3N0YXR1cy1iYW5uZXInKTsKICAgIGlmIChiYW5uZXIpIHsKICAgICAgYmFubmVyLmNsYXNzTGlzdC50b2dnbGUoJ3NpbWlsYXInLCAhIWlzU2ltaWxhcik7CiAgICAgIGJhbm5lci5jbGFzc0xpc3QudG9nZ2xlKCduby1zaW1pbGFyJywgIWlzU2ltaWxhcik7CiAgICB9CiAgICBjb25zdCBzdWIgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcjc3RhdHVzLWJhbm5lciAucy1zdWInKTsKICAgIGlmIChzdWIpIHsKICAgICAgc3ViLnRleHRDb250ZW50ID0gaXNTaW1pbGFyCiAgICAgICAgPyAnTGEgYnJlY2hhIGVzdMOhIGRlbnRybyBkZWwgdW1icmFsIOKAlCBsb3MgcHJlY2lvcyBzb24gY29tcGFyYWJsZXMnCiAgICAgICAgOiAnTGEgYnJlY2hhIHN1cGVyYSBlbCB1bWJyYWwg4oCUIGxvcyBwcmVjaW9zIG5vIHNvbiBjb21wYXJhYmxlcyc7CiAgICB9CiAgICBjb25zdCBpc09wZW4gPSBkYXRhPy5tYXJrZXQgJiYgdHlwZW9mIGRhdGEubWFya2V0LmlzT3BlbiA9PT0gJ2Jvb2xlYW4nID8gZGF0YS5tYXJrZXQuaXNPcGVuIDogbnVsbDsKICAgIGlmIChpc09wZW4gIT09IG51bGwpIHNldE1hcmtldFRhZyhpc09wZW4pOwogICAgc3RhdGUubGF0ZXN0Lm1lcCA9IG1lcDsKICAgIHN0YXRlLmxhdGVzdC5jY2wgPSBjY2w7CiAgICBzdGF0ZS5sYXRlc3QuYnJlY2hhQWJzID0gYWJzOwogICAgc3RhdGUubGF0ZXN0LmJyZWNoYVBjdCA9IHBjdDsKICB9CgogIGZ1bmN0aW9uIGlzU2ltaWxhclJvdyhyb3cpIHsKICAgIGNvbnN0IGFicyA9IHJvdy5hYnNfZGlmZiAhPSBudWxsID8gcm93LmFic19kaWZmIDogTWF0aC5hYnMocm93Lm1lcCAtIHJvdy5jY2wpOwogICAgY29uc3QgcGN0ID0gcm93LnBjdF9kaWZmICE9IG51bGwgPyByb3cucGN0X2RpZmYgOiBjYWxjQnJlY2hhUGN0KHJvdy5tZXAsIHJvdy5jY2wpOwogICAgcmV0dXJuIChOdW1iZXIuaXNGaW5pdGUocGN0KSAmJiBwY3QgPD0gU0lNSUxBUl9QQ1RfVEhSRVNIT0xEKSB8fCAoTnVtYmVyLmlzRmluaXRlKGFicykgJiYgYWJzIDw9IFNJTUlMQVJfQVJTX1RIUkVTSE9MRCk7CiAgfQoKICBmdW5jdGlvbiBmaWx0ZXJEZXNjcmlwdG9yKG1vZGUgPSBzdGF0ZS5maWx0ZXJNb2RlKSB7CiAgICBpZiAobW9kZSA9PT0gJzFtJykgcmV0dXJuICcxIE1lcyc7CiAgICBpZiAobW9kZSA9PT0gJzF3JykgcmV0dXJuICcxIFNlbWFuYSc7CiAgICByZXR1cm4gJzEgRMOtYSc7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJNZXRyaWNzMjRoKHBheWxvYWQpIHsKICAgIGNvbnN0IGZpbHRlcmVkID0gZmlsdGVySGlzdG9yeVJvd3MoZXh0cmFjdEhpc3RvcnlSb3dzKHBheWxvYWQpLCBzdGF0ZS5maWx0ZXJNb2RlKTsKICAgIGNvbnN0IHBjdFZhbHVlcyA9IGZpbHRlcmVkLm1hcCgocikgPT4gKHIucGN0X2RpZmYgIT0gbnVsbCA/IHIucGN0X2RpZmYgOiBjYWxjQnJlY2hhUGN0KHIubWVwLCByLmNjbCkpKS5maWx0ZXIoKHYpID0+IE51bWJlci5pc0Zpbml0ZSh2KSk7CiAgICBjb25zdCBzaW1pbGFyQ291bnQgPSBmaWx0ZXJlZC5maWx0ZXIoKHIpID0+IGlzU2ltaWxhclJvdyhyKSkubGVuZ3RoOwogICAgY29uc3QgZGVzY3JpcHRvciA9IGZpbHRlckRlc2NyaXB0b3IoKTsKCiAgICBzZXRUZXh0KCdtZXRyaWMtY291bnQtbGFiZWwnLCBgTXVlc3RyYXMgJHtkZXNjcmlwdG9yfWApOwogICAgc2V0VGV4dCgnbWV0cmljLWNvdW50LTI0aCcsIFN0cmluZyhmaWx0ZXJlZC5sZW5ndGgpLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc2V0VGV4dCgnbWV0cmljLWNvdW50LXN1YicsICdyZWdpc3Ryb3MgZGVsIHBlcsOtb2RvIGZpbHRyYWRvJyk7CiAgICBzZXRUZXh0KCdtZXRyaWMtc2ltaWxhci1sYWJlbCcsIGBWZWNlcyBzaW1pbGFyICgke2Rlc2NyaXB0b3J9KWApOwogICAgc2V0VGV4dCgnbWV0cmljLXNpbWlsYXItMjRoJywgU3RyaW5nKHNpbWlsYXJDb3VudCksIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdtZXRyaWMtc2ltaWxhci1zdWInLCAnbW9tZW50b3MgZW4gem9uYSDiiaQxJSBvIOKJpCQxMCcpOwogICAgc2V0VGV4dCgnbWV0cmljLW1pbi1sYWJlbCcsIGBCcmVjaGEgbcOtbi4gKCR7ZGVzY3JpcHRvcn0pYCk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWluLTI0aCcsIHBjdFZhbHVlcy5sZW5ndGggPyBmb3JtYXRQZXJjZW50KE1hdGgubWluKC4uLnBjdFZhbHVlcyksIDIpIDogJ+KAlCcsIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWluLXN1YicsICdtw61uaW1hIGRlbCBwZXLDrW9kbyBmaWx0cmFkbycpOwogICAgc2V0VGV4dCgnbWV0cmljLW1heC1sYWJlbCcsIGBCcmVjaGEgbcOheC4gKCR7ZGVzY3JpcHRvcn0pYCk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWF4LTI0aCcsIHBjdFZhbHVlcy5sZW5ndGggPyBmb3JtYXRQZXJjZW50KE1hdGgubWF4KC4uLnBjdFZhbHVlcyksIDIpIDogJ+KAlCcsIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWF4LXN1YicsICdtw6F4aW1hIGRlbCBwZXLDrW9kbyBmaWx0cmFkbycpOwogICAgc2V0VGV4dCgndHJlbmQtdGl0bGUnLCBgVGVuZGVuY2lhIE1FUC9DQ0wg4oCUICR7ZGVzY3JpcHRvcn1gKTsKICB9CgogIGZ1bmN0aW9uIHJvd0hvdXJMYWJlbChlcG9jaCkgewogICAgY29uc3QgbiA9IHRvTnVtYmVyKGVwb2NoKTsKICAgIGlmIChuID09PSBudWxsKSByZXR1cm4gJ+KAlCc7CiAgICByZXR1cm4gZm10QXJnSG91ci5mb3JtYXQobmV3IERhdGUobiAqIDEwMDApKTsKICB9CiAgZnVuY3Rpb24gcm93RGF5SG91ckxhYmVsKGVwb2NoKSB7CiAgICBjb25zdCBuID0gdG9OdW1iZXIoZXBvY2gpOwogICAgaWYgKG4gPT09IG51bGwpIHJldHVybiAn4oCUJzsKICAgIGNvbnN0IGRhdGUgPSBuZXcgRGF0ZShuICogMTAwMCk7CiAgICByZXR1cm4gYCR7Zm10QXJnRGF5TW9udGguZm9ybWF0KGRhdGUpfSAke2ZtdEFyZ0hvdXIuZm9ybWF0KGRhdGUpfWA7CiAgfQogIGZ1bmN0aW9uIGFydERhdGVLZXkoZXBvY2gpIHsKICAgIGNvbnN0IG4gPSB0b051bWJlcihlcG9jaCk7CiAgICBpZiAobiA9PT0gbnVsbCkgcmV0dXJuIG51bGw7CiAgICByZXR1cm4gZm10QXJnRGF0ZS5mb3JtYXQobmV3IERhdGUobiAqIDEwMDApKTsKICB9CiAgZnVuY3Rpb24gYXJ0V2Vla2RheShlcG9jaCkgewogICAgY29uc3QgbiA9IHRvTnVtYmVyKGVwb2NoKTsKICAgIGlmIChuID09PSBudWxsKSByZXR1cm4gbnVsbDsKICAgIHJldHVybiBmbXRBcmdXZWVrZGF5LmZvcm1hdChuZXcgRGF0ZShuICogMTAwMCkpOwogIH0KICBmdW5jdGlvbiBleHRyYWN0SGlzdG9yeVJvd3MocGF5bG9hZCkgewogICAgY29uc3QgZGF0YSA9IGV4dHJhY3RSb290KHBheWxvYWQpOwogICAgY29uc3Qgcm93cyA9IEFycmF5LmlzQXJyYXkoZGF0YS5oaXN0b3J5KSA/IGRhdGEuaGlzdG9yeS5zbGljZSgpIDogW107CiAgICByZXR1cm4gcm93cwogICAgICAubWFwKChyKSA9PiAoewogICAgICAgIGVwb2NoOiB0b051bWJlcihyLmVwb2NoKSwKICAgICAgICBtZXA6IHRvTnVtYmVyKHIubWVwKSwKICAgICAgICBjY2w6IHRvTnVtYmVyKHIuY2NsKSwKICAgICAgICBhYnNfZGlmZjogdG9OdW1iZXIoci5hYnNfZGlmZiksCiAgICAgICAgcGN0X2RpZmY6IHRvTnVtYmVyKHIucGN0X2RpZmYpLAogICAgICAgIHNpbWlsYXI6IEJvb2xlYW4oci5zaW1pbGFyKQogICAgICB9KSkKICAgICAgLmZpbHRlcigocikgPT4gci5lcG9jaCAhPSBudWxsICYmIHIubWVwICE9IG51bGwgJiYgci5jY2wgIT0gbnVsbCkKICAgICAgLnNvcnQoKGEsIGIpID0+IGEuZXBvY2ggLSBiLmVwb2NoKTsKICB9CiAgZnVuY3Rpb24gZmlsdGVySGlzdG9yeVJvd3Mocm93cywgbW9kZSkgewogICAgaWYgKCFyb3dzLmxlbmd0aCkgcmV0dXJuIFtdOwogICAgY29uc3QgbGF0ZXN0RXBvY2ggPSByb3dzW3Jvd3MubGVuZ3RoIC0gMV0uZXBvY2g7CiAgICBpZiAobW9kZSA9PT0gJzFtJykgewogICAgICBjb25zdCBjdXRvZmYgPSBsYXRlc3RFcG9jaCAtICgzMCAqIDI0ICogMzYwMCk7CiAgICAgIHJldHVybiByb3dzLmZpbHRlcigocikgPT4gci5lcG9jaCA+PSBjdXRvZmYpOwogICAgfQogICAgaWYgKG1vZGUgPT09ICcxdycpIHsKICAgICAgY29uc3QgYWxsb3dlZERheXMgPSBuZXcgU2V0KCk7CiAgICAgIGZvciAobGV0IGkgPSByb3dzLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7CiAgICAgICAgY29uc3QgZGF5ID0gYXJ0RGF0ZUtleShyb3dzW2ldLmVwb2NoKTsKICAgICAgICBjb25zdCB3ZCA9IGFydFdlZWtkYXkocm93c1tpXS5lcG9jaCk7CiAgICAgICAgaWYgKCFkYXkgfHwgd2QgPT09ICdTYXQnIHx8IHdkID09PSAnU3VuJykgY29udGludWU7CiAgICAgICAgYWxsb3dlZERheXMuYWRkKGRheSk7CiAgICAgICAgaWYgKGFsbG93ZWREYXlzLnNpemUgPj0gNSkgYnJlYWs7CiAgICAgIH0KICAgICAgcmV0dXJuIHJvd3MuZmlsdGVyKChyKSA9PiB7CiAgICAgICAgY29uc3QgZGF5ID0gYXJ0RGF0ZUtleShyLmVwb2NoKTsKICAgICAgICByZXR1cm4gZGF5ICYmIGFsbG93ZWREYXlzLmhhcyhkYXkpOwogICAgICB9KTsKICAgIH0KICAgIGNvbnN0IGN1dG9mZiA9IGxhdGVzdEVwb2NoIC0gKDI0ICogMzYwMCk7CiAgICByZXR1cm4gcm93cy5maWx0ZXIoKHIpID0+IHIuZXBvY2ggPj0gY3V0b2ZmKTsKICB9CiAgZnVuY3Rpb24gZG93bnNhbXBsZVJvd3Mocm93cywgbWF4UG9pbnRzKSB7CiAgICBpZiAocm93cy5sZW5ndGggPD0gbWF4UG9pbnRzKSByZXR1cm4gcm93czsKICAgIGNvbnN0IG91dCA9IFtdOwogICAgY29uc3Qgc3RlcCA9IChyb3dzLmxlbmd0aCAtIDEpIC8gKG1heFBvaW50cyAtIDEpOwogICAgZm9yIChsZXQgaSA9IDA7IGkgPCBtYXhQb2ludHM7IGkrKykgewogICAgICBvdXQucHVzaChyb3dzW01hdGgucm91bmQoaSAqIHN0ZXApXSk7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KICBmdW5jdGlvbiBjdXJyZW50RmlsdGVyTGFiZWwoKSB7CiAgICBpZiAoc3RhdGUuZmlsdGVyTW9kZSA9PT0gJzFtJykgcmV0dXJuICcxIE1lcyc7CiAgICBpZiAoc3RhdGUuZmlsdGVyTW9kZSA9PT0gJzF3JykgcmV0dXJuICcxIFNlbWFuYSc7CiAgICByZXR1cm4gJzEgRMOtYSc7CiAgfQogIGZ1bmN0aW9uIGFwcGx5RmlsdGVyKG1vZGUpIHsKICAgIHN0YXRlLmZpbHRlck1vZGUgPSBtb2RlOwogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnBpbGxbZGF0YS1maWx0ZXJdJykuZm9yRWFjaCgoYnRuKSA9PiB7CiAgICAgIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKCdvbicsIGJ0bi5kYXRhc2V0LmZpbHRlciA9PT0gbW9kZSk7CiAgICB9KTsKICAgIGlmIChzdGF0ZS5sYXN0TWVwUGF5bG9hZCkgewogICAgICByZW5kZXJUcmVuZChzdGF0ZS5sYXN0TWVwUGF5bG9hZCk7CiAgICAgIHJlbmRlckhpc3Rvcnkoc3RhdGUubGFzdE1lcFBheWxvYWQpOwogICAgICByZW5kZXJNZXRyaWNzMjRoKHN0YXRlLmxhc3RNZXBQYXlsb2FkKTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIHJlbmRlckhpc3RvcnkocGF5bG9hZCkgewogICAgY29uc3QgdGJvZHkgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGlzdG9yeS1yb3dzJyk7CiAgICBjb25zdCBjYXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGlzdG9yeS1jYXAnKTsKICAgIGlmICghdGJvZHkpIHJldHVybjsKICAgIGNvbnN0IGZpbHRlcmVkID0gZmlsdGVySGlzdG9yeVJvd3MoZXh0cmFjdEhpc3RvcnlSb3dzKHBheWxvYWQpLCBzdGF0ZS5maWx0ZXJNb2RlKTsKICAgIGNvbnN0IHJvd3MgPSBmaWx0ZXJlZC5zbGljZSgpLnJldmVyc2UoKTsKICAgIGlmIChjYXApIGNhcC50ZXh0Q29udGVudCA9IGAke2N1cnJlbnRGaWx0ZXJMYWJlbCgpfSDCtyAke3Jvd3MubGVuZ3RofSByZWdpc3Ryb3NgOwogICAgaWYgKCFyb3dzLmxlbmd0aCkgewogICAgICB0Ym9keS5pbm5lckhUTUwgPSAnPHRyPjx0ZCBjbGFzcz0iZGltIiBjb2xzcGFuPSI2Ij5TaW4gcmVnaXN0cm9zIHRvZGF2w61hPC90ZD48L3RyPic7CiAgICAgIHJldHVybjsKICAgIH0KICAgIHRib2R5LmlubmVySFRNTCA9IHJvd3MubWFwKChyKSA9PiB7CiAgICAgIGNvbnN0IG1lcCA9IHRvTnVtYmVyKHIubWVwKTsKICAgICAgY29uc3QgY2NsID0gdG9OdW1iZXIoci5jY2wpOwogICAgICBjb25zdCBhYnMgPSB0b051bWJlcihyLmFic19kaWZmKTsKICAgICAgY29uc3QgcGN0ID0gdG9OdW1iZXIoci5wY3RfZGlmZik7CiAgICAgIGNvbnN0IHNpbSA9IEJvb2xlYW4oci5zaW1pbGFyKTsKICAgICAgcmV0dXJuIGA8dHI+CiAgICAgICAgPHRkIGNsYXNzPSJkaW0iPjxkaXYgY2xhc3M9InRzLWRheSI+JHtmbXRBcmdEYXlNb250aC5mb3JtYXQobmV3IERhdGUoci5lcG9jaCAqIDEwMDApKX08L2Rpdj48ZGl2IGNsYXNzPSJ0cy1ob3VyIj4ke3Jvd0hvdXJMYWJlbChyLmVwb2NoKX08L2Rpdj48L3RkPgogICAgICAgIDx0ZCBzdHlsZT0iY29sb3I6dmFyKC0tbWVwKSI+JHtmb3JtYXRNb25leShtZXAsIDIpfTwvdGQ+CiAgICAgICAgPHRkIHN0eWxlPSJjb2xvcjp2YXIoLS1jY2wpIj4ke2Zvcm1hdE1vbmV5KGNjbCwgMil9PC90ZD4KICAgICAgICA8dGQ+JHtmb3JtYXRNb25leShhYnMsIDIpfTwvdGQ+CiAgICAgICAgPHRkPiR7Zm9ybWF0UGVyY2VudChwY3QsIDIpfTwvdGQ+CiAgICAgICAgPHRkPjxzcGFuIGNsYXNzPSJzYmFkZ2UgJHtzaW0gPyAnc2ltJyA6ICdub3NpbSd9Ij4ke3NpbSA/ICdTaW1pbGFyJyA6ICdObyBzaW1pbGFyJ308L3NwYW4+PC90ZD4KICAgICAgPC90cj5gOwogICAgfSkuam9pbignJyk7CiAgfQoKICBmdW5jdGlvbiBsaW5lUG9pbnRzKHZhbHVlcywgeDAsIHgxLCB5MCwgeTEsIG1pblZhbHVlLCBtYXhWYWx1ZSkgewogICAgaWYgKCF2YWx1ZXMubGVuZ3RoKSByZXR1cm4gJyc7CiAgICBjb25zdCBtaW4gPSBOdW1iZXIuaXNGaW5pdGUobWluVmFsdWUpID8gbWluVmFsdWUgOiBNYXRoLm1pbiguLi52YWx1ZXMpOwogICAgY29uc3QgbWF4ID0gTnVtYmVyLmlzRmluaXRlKG1heFZhbHVlKSA/IG1heFZhbHVlIDogTWF0aC5tYXgoLi4udmFsdWVzKTsKICAgIGNvbnN0IHNwYW4gPSBNYXRoLm1heCgwLjAwMDAwMSwgbWF4IC0gbWluKTsKICAgIHJldHVybiB2YWx1ZXMubWFwKCh2LCBpKSA9PiB7CiAgICAgIGNvbnN0IHggPSB4MCArICgoeDEgLSB4MCkgKiBpIC8gTWF0aC5tYXgoMSwgdmFsdWVzLmxlbmd0aCAtIDEpKTsKICAgICAgY29uc3QgeSA9IHkxIC0gKCh2IC0gbWluKSAvIHNwYW4pICogKHkxIC0geTApOwogICAgICByZXR1cm4gYCR7eC50b0ZpeGVkKDIpfSwke3kudG9GaXhlZCgyKX1gOwogICAgfSkuam9pbignICcpOwogIH0KICBmdW5jdGlvbiB2YWx1ZVRvWSh2YWx1ZSwgeTAsIHkxLCBtaW5WYWx1ZSwgbWF4VmFsdWUpIHsKICAgIGNvbnN0IHNwYW4gPSBNYXRoLm1heCgwLjAwMDAwMSwgbWF4VmFsdWUgLSBtaW5WYWx1ZSk7CiAgICByZXR1cm4geTEgLSAoKHZhbHVlIC0gbWluVmFsdWUpIC8gc3BhbikgKiAoeTEgLSB5MCk7CiAgfQogIGZ1bmN0aW9uIGNhbGNCcmVjaGFQY3QobWVwLCBjY2wpIHsKICAgIGlmICghTnVtYmVyLmlzRmluaXRlKG1lcCkgfHwgIU51bWJlci5pc0Zpbml0ZShjY2wpKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGF2ZyA9IChtZXAgKyBjY2wpIC8gMjsKICAgIGlmICghYXZnKSByZXR1cm4gbnVsbDsKICAgIHJldHVybiAoTWF0aC5hYnMobWVwIC0gY2NsKSAvIGF2ZykgKiAxMDA7CiAgfQogIGZ1bmN0aW9uIGhpZGVUcmVuZEhvdmVyKCkgewogICAgY29uc3QgdGlwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLXRvb2x0aXAnKTsKICAgIGNvbnN0IGxpbmUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtaG92ZXItbGluZScpOwogICAgY29uc3QgbWVwRG90ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLWhvdmVyLW1lcCcpOwogICAgY29uc3QgY2NsRG90ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLWhvdmVyLWNjbCcpOwogICAgaWYgKHRpcCkgdGlwLnNldEF0dHJpYnV0ZSgnb3BhY2l0eScsICcwJyk7CiAgICBpZiAobGluZSkgbGluZS5zZXRBdHRyaWJ1dGUoJ29wYWNpdHknLCAnMCcpOwogICAgaWYgKG1lcERvdCkgbWVwRG90LnNldEF0dHJpYnV0ZSgnb3BhY2l0eScsICcwJyk7CiAgICBpZiAoY2NsRG90KSBjY2xEb3Quc2V0QXR0cmlidXRlKCdvcGFjaXR5JywgJzAnKTsKICB9CiAgZnVuY3Rpb24gcmVuZGVyVHJlbmRIb3Zlcihwb2ludCkgewogICAgY29uc3QgdGlwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLXRvb2x0aXAnKTsKICAgIGNvbnN0IGJnID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLXRvb2x0aXAtYmcnKTsKICAgIGNvbnN0IGxpbmUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtaG92ZXItbGluZScpOwogICAgY29uc3QgbWVwRG90ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLWhvdmVyLW1lcCcpOwogICAgY29uc3QgY2NsRG90ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLWhvdmVyLWNjbCcpOwogICAgaWYgKCF0aXAgfHwgIWJnIHx8ICFsaW5lIHx8ICFtZXBEb3QgfHwgIWNjbERvdCB8fCAhcG9pbnQpIHJldHVybjsKCiAgICBsaW5lLnNldEF0dHJpYnV0ZSgneDEnLCBwb2ludC54LnRvRml4ZWQoMikpOwogICAgbGluZS5zZXRBdHRyaWJ1dGUoJ3gyJywgcG9pbnQueC50b0ZpeGVkKDIpKTsKICAgIGxpbmUuc2V0QXR0cmlidXRlKCdvcGFjaXR5JywgJzEnKTsKICAgIG1lcERvdC5zZXRBdHRyaWJ1dGUoJ2N4JywgcG9pbnQueC50b0ZpeGVkKDIpKTsKICAgIG1lcERvdC5zZXRBdHRyaWJ1dGUoJ2N5JywgcG9pbnQubWVwWS50b0ZpeGVkKDIpKTsKICAgIG1lcERvdC5zZXRBdHRyaWJ1dGUoJ29wYWNpdHknLCAnMScpOwogICAgY2NsRG90LnNldEF0dHJpYnV0ZSgnY3gnLCBwb2ludC54LnRvRml4ZWQoMikpOwogICAgY2NsRG90LnNldEF0dHJpYnV0ZSgnY3knLCBwb2ludC5jY2xZLnRvRml4ZWQoMikpOwogICAgY2NsRG90LnNldEF0dHJpYnV0ZSgnb3BhY2l0eScsICcxJyk7CgogICAgc2V0VGV4dCgndHJlbmQtdGlwLXRpbWUnLCByb3dEYXlIb3VyTGFiZWwocG9pbnQuZXBvY2gpKTsKICAgIHNldFRleHQoJ3RyZW5kLXRpcC1tZXAnLCBgTUVQICR7Zm9ybWF0TW9uZXkocG9pbnQubWVwLCAyKX1gKTsKICAgIHNldFRleHQoJ3RyZW5kLXRpcC1jY2wnLCBgQ0NMICR7Zm9ybWF0TW9uZXkocG9pbnQuY2NsLCAyKX1gKTsKICAgIHNldFRleHQoJ3RyZW5kLXRpcC1nYXAnLCBgQnJlY2hhICR7Zm9ybWF0UGVyY2VudChwb2ludC5wY3QsIDIpfWApOwoKICAgIGNvbnN0IHRpcFcgPSAxNDg7CiAgICBjb25zdCB0aXBIID0gNTY7CiAgICBjb25zdCB0aXBYID0gTWF0aC5taW4oODQwIC0gdGlwVywgTWF0aC5tYXgoMzAsIHBvaW50LnggKyAxMCkpOwogICAgY29uc3QgdGlwWSA9IE1hdGgubWluKDEwMCwgTWF0aC5tYXgoMTgsIE1hdGgubWluKHBvaW50Lm1lcFksIHBvaW50LmNjbFkpIC0gdGlwSCAtIDQpKTsKICAgIHRpcC5zZXRBdHRyaWJ1dGUoJ3RyYW5zZm9ybScsIGB0cmFuc2xhdGUoJHt0aXBYLnRvRml4ZWQoMil9ICR7dGlwWS50b0ZpeGVkKDIpfSlgKTsKICAgIGJnLnNldEF0dHJpYnV0ZSgnd2lkdGgnLCBTdHJpbmcodGlwVykpOwogICAgYmcuc2V0QXR0cmlidXRlKCdoZWlnaHQnLCBTdHJpbmcodGlwSCkpOwogICAgdGlwLnNldEF0dHJpYnV0ZSgnb3BhY2l0eScsICcxJyk7CiAgfQogIGZ1bmN0aW9uIGJpbmRUcmVuZEhvdmVyKCkgewogICAgaWYgKHN0YXRlLnRyZW5kSG92ZXJCb3VuZCkgcmV0dXJuOwogICAgY29uc3QgY2hhcnQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtY2hhcnQnKTsKICAgIGlmICghY2hhcnQpIHJldHVybjsKICAgIHN0YXRlLnRyZW5kSG92ZXJCb3VuZCA9IHRydWU7CgogICAgY2hhcnQuYWRkRXZlbnRMaXN0ZW5lcignbW91c2VsZWF2ZScsICgpID0+IGhpZGVUcmVuZEhvdmVyKCkpOwogICAgY2hhcnQuYWRkRXZlbnRMaXN0ZW5lcignbW91c2Vtb3ZlJywgKGV2ZW50KSA9PiB7CiAgICAgIGlmICghc3RhdGUudHJlbmRSb3dzLmxlbmd0aCkgcmV0dXJuOwogICAgICBjb25zdCBjdG0gPSBjaGFydC5nZXRTY3JlZW5DVE0oKTsKICAgICAgaWYgKCFjdG0pIHJldHVybjsKICAgICAgY29uc3QgcHQgPSBjaGFydC5jcmVhdGVTVkdQb2ludCgpOwogICAgICBwdC54ID0gZXZlbnQuY2xpZW50WDsKICAgICAgcHQueSA9IGV2ZW50LmNsaWVudFk7CiAgICAgIGNvbnN0IGxvY2FsID0gcHQubWF0cml4VHJhbnNmb3JtKGN0bS5pbnZlcnNlKCkpOwogICAgICBjb25zdCB4ID0gTWF0aC5tYXgoMzAsIE1hdGgubWluKDg0MCwgbG9jYWwueCkpOwogICAgICBsZXQgbmVhcmVzdCA9IHN0YXRlLnRyZW5kUm93c1swXTsKICAgICAgbGV0IGJlc3QgPSBNYXRoLmFicyhuZWFyZXN0LnggLSB4KTsKICAgICAgZm9yIChsZXQgaSA9IDE7IGkgPCBzdGF0ZS50cmVuZFJvd3MubGVuZ3RoOyBpKyspIHsKICAgICAgICBjb25zdCBkID0gTWF0aC5hYnMoc3RhdGUudHJlbmRSb3dzW2ldLnggLSB4KTsKICAgICAgICBpZiAoZCA8IGJlc3QpIHsKICAgICAgICAgIGJlc3QgPSBkOwogICAgICAgICAgbmVhcmVzdCA9IHN0YXRlLnRyZW5kUm93c1tpXTsKICAgICAgICB9CiAgICAgIH0KICAgICAgcmVuZGVyVHJlbmRIb3ZlcihuZWFyZXN0KTsKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyVHJlbmQocGF5bG9hZCkgewogICAgY29uc3QgaGlzdG9yeSA9IGRvd25zYW1wbGVSb3dzKGZpbHRlckhpc3RvcnlSb3dzKGV4dHJhY3RIaXN0b3J5Um93cyhwYXlsb2FkKSwgc3RhdGUuZmlsdGVyTW9kZSksIFRSRU5EX01BWF9QT0lOVFMpOwogICAgY29uc3QgbWVwTGluZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1tZXAtbGluZScpOwogICAgY29uc3QgY2NsTGluZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1jY2wtbGluZScpOwogICAgaWYgKCFtZXBMaW5lIHx8ICFjY2xMaW5lKSByZXR1cm47CiAgICBiaW5kVHJlbmRIb3ZlcigpOwogICAgaWYgKCFoaXN0b3J5Lmxlbmd0aCkgewogICAgICBtZXBMaW5lLnNldEF0dHJpYnV0ZSgncG9pbnRzJywgJycpOwogICAgICBjY2xMaW5lLnNldEF0dHJpYnV0ZSgncG9pbnRzJywgJycpOwogICAgICBzdGF0ZS50cmVuZFJvd3MgPSBbXTsKICAgICAgaGlkZVRyZW5kSG92ZXIoKTsKICAgICAgWyd0cmVuZC15LXRvcCcsICd0cmVuZC15LW1pZCcsICd0cmVuZC15LWxvdycsICd0cmVuZC14LTEnLCAndHJlbmQteC0yJywgJ3RyZW5kLXgtMycsICd0cmVuZC14LTQnLCAndHJlbmQteC01J10uZm9yRWFjaCgoaWQpID0+IHNldFRleHQoaWQsICfigJQnKSk7CiAgICAgIHJldHVybjsKICAgIH0KCiAgICBjb25zdCByb3dzID0gaGlzdG9yeQogICAgICAubWFwKChyKSA9PiAoewogICAgICAgIGVwb2NoOiByLmVwb2NoLAogICAgICAgIG1lcDogdG9OdW1iZXIoci5tZXApLAogICAgICAgIGNjbDogdG9OdW1iZXIoci5jY2wpLAogICAgICAgIHBjdDogdG9OdW1iZXIoci5wY3RfZGlmZikKICAgICAgfSkpCiAgICAgIC5maWx0ZXIoKHIpID0+IHIubWVwICE9IG51bGwgJiYgci5jY2wgIT0gbnVsbCk7CiAgICBpZiAoIXJvd3MubGVuZ3RoKSByZXR1cm47CgogICAgY29uc3QgbWVwVmFscyA9IHJvd3MubWFwKChyKSA9PiByLm1lcCk7CiAgICBjb25zdCBjY2xWYWxzID0gcm93cy5tYXAoKHIpID0+IHIuY2NsKTsKCiAgICAvLyBFc2NhbGEgY29tcGFydGlkYSBwYXJhIE1FUCB5IENDTDogY29tcGFyYWNpw7NuIHZpc3VhbCBmaWVsLgogICAgY29uc3QgYWxsUHJpY2VWYWxzID0gbWVwVmFscy5jb25jYXQoY2NsVmFscyk7CiAgICBjb25zdCByYXdNaW4gPSBNYXRoLm1pbiguLi5hbGxQcmljZVZhbHMpOwogICAgY29uc3QgcmF3TWF4ID0gTWF0aC5tYXgoLi4uYWxsUHJpY2VWYWxzKTsKICAgIGNvbnN0IHByaWNlUGFkID0gTWF0aC5tYXgoMSwgKHJhd01heCAtIHJhd01pbikgKiAwLjA4KTsKICAgIGNvbnN0IHByaWNlTWluID0gcmF3TWluIC0gcHJpY2VQYWQ7CiAgICBjb25zdCBwcmljZU1heCA9IHJhd01heCArIHByaWNlUGFkOwoKICAgIG1lcExpbmUuc2V0QXR0cmlidXRlKCdwb2ludHMnLCBsaW5lUG9pbnRzKG1lcFZhbHMsIDMwLCA4NDAsIDI1LCAxMzAsIHByaWNlTWluLCBwcmljZU1heCkpOwogICAgY2NsTGluZS5zZXRBdHRyaWJ1dGUoJ3BvaW50cycsIGxpbmVQb2ludHMoY2NsVmFscywgMzAsIDg0MCwgMjUsIDEzMCwgcHJpY2VNaW4sIHByaWNlTWF4KSk7CiAgICBzdGF0ZS50cmVuZFJvd3MgPSByb3dzLm1hcCgociwgaSkgPT4gewogICAgICBjb25zdCB4ID0gMzAgKyAoKDg0MCAtIDMwKSAqIGkgLyBNYXRoLm1heCgxLCByb3dzLmxlbmd0aCAtIDEpKTsKICAgICAgcmV0dXJuIHsKICAgICAgICBlcG9jaDogci5lcG9jaCwKICAgICAgICBtZXA6IHIubWVwLAogICAgICAgIGNjbDogci5jY2wsCiAgICAgICAgcGN0OiBjYWxjQnJlY2hhUGN0KHIubWVwLCByLmNjbCksCiAgICAgICAgeCwKICAgICAgICBtZXBZOiB2YWx1ZVRvWShyLm1lcCwgMjUsIDEzMCwgcHJpY2VNaW4sIHByaWNlTWF4KSwKICAgICAgICBjY2xZOiB2YWx1ZVRvWShyLmNjbCwgMjUsIDEzMCwgcHJpY2VNaW4sIHByaWNlTWF4KQogICAgICB9OwogICAgfSk7CiAgICBoaWRlVHJlbmRIb3ZlcigpOwoKICAgIGNvbnN0IG1pZCA9IChwcmljZU1pbiArIHByaWNlTWF4KSAvIDI7CiAgICBzZXRUZXh0KCd0cmVuZC15LXRvcCcsIChwcmljZU1heCAvIDEwMDApLnRvRml4ZWQoMykpOwogICAgc2V0VGV4dCgndHJlbmQteS1taWQnLCAobWlkIC8gMTAwMCkudG9GaXhlZCgzKSk7CiAgICBzZXRUZXh0KCd0cmVuZC15LWxvdycsIChwcmljZU1pbiAvIDEwMDApLnRvRml4ZWQoMykpOwoKICAgIGNvbnN0IGlkeCA9IFswLCAwLjI1LCAwLjUsIDAuNzUsIDFdLm1hcCgocCkgPT4gTWF0aC5taW4ocm93cy5sZW5ndGggLSAxLCBNYXRoLmZsb29yKChyb3dzLmxlbmd0aCAtIDEpICogcCkpKTsKICAgIGNvbnN0IGxhYnMgPSBpZHgubWFwKChpKSA9PiByb3dEYXlIb3VyTGFiZWwocm93c1tpXT8uZXBvY2gpKTsKICAgIHNldFRleHQoJ3RyZW5kLXgtMScsIGxhYnNbMF0gfHwgJ+KAlCcpOwogICAgc2V0VGV4dCgndHJlbmQteC0yJywgbGFic1sxXSB8fCAn4oCUJyk7CiAgICBzZXRUZXh0KCd0cmVuZC14LTMnLCBsYWJzWzJdIHx8ICfigJQnKTsKICAgIHNldFRleHQoJ3RyZW5kLXgtNCcsIGxhYnNbM10gfHwgJ+KAlCcpOwogICAgc2V0VGV4dCgndHJlbmQteC01JywgbGFic1s0XSB8fCAn4oCUJyk7CiAgfQoKICAvLyA0KSBGdW5jacOzbiBjZW50cmFsIGZldGNoQWxsKCkKICBhc3luYyBmdW5jdGlvbiBmZXRjaEpzb24odXJsKSB7CiAgICBjb25zdCBjdHJsID0gbmV3IEFib3J0Q29udHJvbGxlcigpOwogICAgY29uc3QgdGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4gY3RybC5hYm9ydCgpLCAxMjAwMCk7CiAgICB0cnkgewogICAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHsgY2FjaGU6ICduby1zdG9yZScsIHNpZ25hbDogY3RybC5zaWduYWwgfSk7CiAgICAgIGlmICghcmVzLm9rKSB0aHJvdyBuZXcgRXJyb3IoYEhUVFAgJHtyZXMuc3RhdHVzfWApOwogICAgICByZXR1cm4gYXdhaXQgcmVzLmpzb24oKTsKICAgIH0gZmluYWxseSB7CiAgICAgIGNsZWFyVGltZW91dCh0aW1lb3V0KTsKICAgIH0KICB9CgogIGFzeW5jIGZ1bmN0aW9uIGZldGNoQWxsKG9wdGlvbnMgPSB7fSkgewogICAgaWYgKHN0YXRlLmlzRmV0Y2hpbmcpIHJldHVybjsKICAgIHN0YXRlLmlzRmV0Y2hpbmcgPSB0cnVlOwogICAgc2V0TG9hZGluZyhOVU1FUklDX0lEUywgdHJ1ZSk7CiAgICBzZXRGcmVzaEJhZGdlKCdBY3R1YWxpemFuZG/igKYnLCAnZmV0Y2hpbmcnKTsKICAgIHNldEVycm9yQmFubmVyKGZhbHNlKTsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHRhc2tzID0gWwogICAgICAgIFsnbWVwQ2NsJywgRU5EUE9JTlRTLm1lcENjbF0KICAgICAgXTsKCiAgICAgIGNvbnN0IHNldHRsZWQgPSBhd2FpdCBQcm9taXNlLmFsbFNldHRsZWQodGFza3MubWFwKGFzeW5jIChbbmFtZSwgdXJsXSkgPT4gewogICAgICAgIHRyeSB7CiAgICAgICAgICBjb25zdCBkYXRhID0gYXdhaXQgZmV0Y2hKc29uKHVybCk7CiAgICAgICAgICByZXR1cm4geyBuYW1lLCBkYXRhIH07CiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHsKICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYFtSYWRhck1FUF0gZXJyb3IgZW4gJHtuYW1lfWAsIGVycm9yKTsKICAgICAgICAgIHRocm93IHsgbmFtZSwgZXJyb3IgfTsKICAgICAgICB9CiAgICAgIH0pKTsKCiAgICAgIGNvbnN0IGJhZyA9IHsgdGltZXN0YW1wOiBEYXRlLm5vdygpLCBtZXBDY2w6IG51bGwgfTsKICAgICAgY29uc3QgZmFpbGVkID0gW107CiAgICAgIHNldHRsZWQuZm9yRWFjaCgociwgaWR4KSA9PiB7CiAgICAgICAgY29uc3QgbmFtZSA9IHRhc2tzW2lkeF1bMF07CiAgICAgICAgaWYgKHIuc3RhdHVzID09PSAnZnVsZmlsbGVkJykgYmFnW25hbWVdID0gci52YWx1ZS5kYXRhOwogICAgICAgIGVsc2UgZmFpbGVkLnB1c2gobmFtZSk7CiAgICAgIH0pOwoKICAgICAgcmVuZGVyTWVwQ2NsKGJhZy5tZXBDY2wpOwogICAgICBzdGF0ZS5sYXN0TWVwUGF5bG9hZCA9IGJhZy5tZXBDY2w7CiAgICAgIHJlbmRlck1ldHJpY3MyNGgoYmFnLm1lcENjbCk7CiAgICAgIHJlbmRlclRyZW5kKGJhZy5tZXBDY2wpOwogICAgICByZW5kZXJIaXN0b3J5KGJhZy5tZXBDY2wpOwogICAgICBjb25zdCBtZXBSb290ID0gZXh0cmFjdFJvb3QoYmFnLm1lcENjbCk7CiAgICAgIGNvbnN0IHVwZGF0ZWRBcnQgPSB0eXBlb2YgbWVwUm9vdD8udXBkYXRlZEF0SHVtYW5BcnQgPT09ICdzdHJpbmcnID8gbWVwUm9vdC51cGRhdGVkQXRIdW1hbkFydCA6IG51bGw7CiAgICAgIGNvbnN0IHNvdXJjZUZyZXNoID0gdHlwZW9mIG1lcFJvb3Q/LnNvdXJjZVN0YXR1cz8uZnJlc2hMYWJlbCA9PT0gJ3N0cmluZycgPyBtZXBSb290LnNvdXJjZVN0YXR1cy5mcmVzaExhYmVsIDogbnVsbDsKICAgICAgc2V0VGV4dCgnbGFzdC1ydW4tdGltZScsIHVwZGF0ZWRBcnQgfHwgZm10QXJnVGltZVNlYy5mb3JtYXQobmV3IERhdGUoKSkpOwoKICAgICAgY29uc3Qgc3VjY2Vzc0NvdW50ID0gdGFza3MubGVuZ3RoIC0gZmFpbGVkLmxlbmd0aDsKICAgICAgaWYgKHN1Y2Nlc3NDb3VudCA+IDApIHsKICAgICAgICBzdGF0ZS5sYXN0U3VjY2Vzc0F0ID0gRGF0ZS5ub3coKTsKICAgICAgICBzdGF0ZS5yZXRyeUluZGV4ID0gMDsKICAgICAgICBpZiAoc3RhdGUucmV0cnlUaW1lcikgY2xlYXJUaW1lb3V0KHN0YXRlLnJldHJ5VGltZXIpOwogICAgICAgIHNhdmVDYWNoZShiYWcpOwogICAgICAgIGNvbnN0IGJhZGdlQmFzZSA9IHNvdXJjZUZyZXNoID8gYEZ1ZW50ZSAke3NvdXJjZUZyZXNofWAgOiBgQWN0dWFsaXphZG8gwrcgJHtmbXRBcmdUaW1lLmZvcm1hdChuZXcgRGF0ZSgpKX1gOwogICAgICAgIGlmIChmYWlsZWQubGVuZ3RoKSBzZXRGcmVzaEJhZGdlKGBBY3R1YWxpemFjacOzbiBwYXJjaWFsIMK3ICR7YmFkZ2VCYXNlfWAsICdpZGxlJyk7CiAgICAgICAgZWxzZSBzZXRGcmVzaEJhZGdlKGJhZGdlQmFzZSwgJ2lkbGUnKTsKICAgICAgfSBlbHNlIHsKICAgICAgICBjb25zdCBhdHRlbXB0ID0gc3RhdGUucmV0cnlJbmRleCArIDE7CiAgICAgICAgaWYgKHN0YXRlLnJldHJ5SW5kZXggPCBSRVRSWV9ERUxBWVMubGVuZ3RoKSB7CiAgICAgICAgICBjb25zdCBkZWxheSA9IFJFVFJZX0RFTEFZU1tzdGF0ZS5yZXRyeUluZGV4XTsKICAgICAgICAgIHN0YXRlLnJldHJ5SW5kZXggKz0gMTsKICAgICAgICAgIHNldEZyZXNoQmFkZ2UoYEVycm9yIMK3IFJlaW50ZW50byBlbiAke01hdGgucm91bmQoZGVsYXkgLyAxMDAwKX1zYCwgJ2Vycm9yJyk7CiAgICAgICAgICBpZiAoc3RhdGUucmV0cnlUaW1lcikgY2xlYXJUaW1lb3V0KHN0YXRlLnJldHJ5VGltZXIpOwogICAgICAgICAgc3RhdGUucmV0cnlUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gZmV0Y2hBbGwoeyBtYW51YWw6IHRydWUgfSksIGRlbGF5KTsKICAgICAgICB9IGVsc2UgewogICAgICAgICAgc2V0RnJlc2hCYWRnZSgnRXJyb3IgwrcgUmVpbnRlbnRhcicsICdlcnJvcicpOwogICAgICAgICAgc2V0RXJyb3JCYW5uZXIodHJ1ZSwgJ0Vycm9yIGFsIGFjdHVhbGl6YXIgwrcgUmVpbnRlbnRhcicpOwogICAgICAgICAgY29uc29sZS5lcnJvcihgW1JhZGFyTUVQXSBzZSBhZ290YXJvbiByZXRyaWVzICgke2F0dGVtcHR9IGludGVudG9zKWApOwogICAgICAgICAgaWYgKHdpbmRvdy5zY2hlZHVsZXIpIHdpbmRvdy5zY2hlZHVsZXIuc3RvcCgpOwogICAgICAgIH0KICAgICAgfQogICAgfSBmaW5hbGx5IHsKICAgICAgc2V0TG9hZGluZyhOVU1FUklDX0lEUywgZmFsc2UpOwogICAgICBzdGF0ZS5pc0ZldGNoaW5nID0gZmFsc2U7CiAgICB9CiAgfQoKICAvLyA1KSBDbGFzZSBNYXJrZXRTY2hlZHVsZXIKICBjbGFzcyBNYXJrZXRTY2hlZHVsZXIgewogICAgY29uc3RydWN0b3IoZmV0Y2hGbiwgaW50ZXJ2YWxNcyA9IDMwMDAwMCkgewogICAgICB0aGlzLmZldGNoRm4gPSBmZXRjaEZuOwogICAgICB0aGlzLmludGVydmFsTXMgPSBpbnRlcnZhbE1zOwogICAgICB0aGlzLnRpbWVyID0gbnVsbDsKICAgICAgdGhpcy53YWl0VGltZXIgPSBudWxsOwogICAgICB0aGlzLmNvdW50ZG93blRpbWVyID0gbnVsbDsKICAgICAgdGhpcy5uZXh0UnVuQXQgPSBudWxsOwogICAgICB0aGlzLnJ1bm5pbmcgPSBmYWxzZTsKICAgICAgdGhpcy5wYXVzZWQgPSBmYWxzZTsKICAgIH0KCiAgICBzdGFydCgpIHsKICAgICAgaWYgKHRoaXMucnVubmluZykgcmV0dXJuOwogICAgICB0aGlzLnJ1bm5pbmcgPSB0cnVlOwogICAgICB0aGlzLnBhdXNlZCA9IGZhbHNlOwogICAgICBpZiAodGhpcy5pc01hcmtldE9wZW4oKSkgewogICAgICAgIHNldE1hcmtldFRhZyh0cnVlKTsKICAgICAgICB0aGlzLl9zY2hlZHVsZSh0aGlzLmludGVydmFsTXMpOwogICAgICB9IGVsc2UgewogICAgICAgIHNldE1hcmtldFRhZyhmYWxzZSk7CiAgICAgICAgdGhpcy5fd2FpdEZvck9wZW4oKTsKICAgICAgfQogICAgICB0aGlzLl9zdGFydENvdW50ZG93bigpOwogICAgfQoKICAgIHBhdXNlKCkgewogICAgICB0aGlzLnBhdXNlZCA9IHRydWU7CiAgICAgIGNsZWFyVGltZW91dCh0aGlzLnRpbWVyKTsKICAgICAgY2xlYXJUaW1lb3V0KHRoaXMud2FpdFRpbWVyKTsKICAgICAgdGhpcy50aW1lciA9IG51bGw7CiAgICAgIHRoaXMud2FpdFRpbWVyID0gbnVsbDsKICAgICAgdGhpcy5fc3RvcENvdW50ZG93bigpOwogICAgICBjb25zdCBjb3VudGRvd24gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY291bnRkb3duLXRleHQnKTsKICAgICAgaWYgKGNvdW50ZG93bikgY291bnRkb3duLnRleHRDb250ZW50ID0gJ0FjdHVhbGl6YWNpw7NuIHBhdXNhZGEnOwogICAgfQoKICAgIHJlc3VtZSgpIHsKICAgICAgaWYgKCF0aGlzLnJ1bm5pbmcpIHRoaXMucnVubmluZyA9IHRydWU7CiAgICAgIHRoaXMucGF1c2VkID0gZmFsc2U7CiAgICAgIGNvbnN0IGNvbnRpbnVlUmVzdW1lID0gKCkgPT4gewogICAgICAgIGlmICh0aGlzLmlzTWFya2V0T3BlbigpKSB7CiAgICAgICAgICBzZXRNYXJrZXRUYWcodHJ1ZSk7CiAgICAgICAgICB0aGlzLl9zY2hlZHVsZSh0aGlzLmludGVydmFsTXMpOwogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICBzZXRNYXJrZXRUYWcoZmFsc2UpOwogICAgICAgICAgdGhpcy5fd2FpdEZvck9wZW4oKTsKICAgICAgICB9CiAgICAgICAgdGhpcy5fc3RhcnRDb3VudGRvd24oKTsKICAgICAgfTsKICAgICAgaWYgKERhdGUubm93KCkgLSBzdGF0ZS5sYXN0U3VjY2Vzc0F0ID4gdGhpcy5pbnRlcnZhbE1zKSB7CiAgICAgICAgUHJvbWlzZS5yZXNvbHZlKHRoaXMuZmV0Y2hGbih7IG1hbnVhbDogdHJ1ZSB9KSkuZmluYWxseShjb250aW51ZVJlc3VtZSk7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgY29udGludWVSZXN1bWUoKTsKICAgICAgfQogICAgfQoKICAgIHN0b3AoKSB7CiAgICAgIHRoaXMucnVubmluZyA9IGZhbHNlOwogICAgICB0aGlzLnBhdXNlZCA9IGZhbHNlOwogICAgICBjbGVhclRpbWVvdXQodGhpcy50aW1lcik7CiAgICAgIGNsZWFyVGltZW91dCh0aGlzLndhaXRUaW1lcik7CiAgICAgIHRoaXMudGltZXIgPSBudWxsOwogICAgICB0aGlzLndhaXRUaW1lciA9IG51bGw7CiAgICAgIHRoaXMubmV4dFJ1bkF0ID0gbnVsbDsKICAgICAgdGhpcy5fc3RvcENvdW50ZG93bigpOwogICAgfQoKICAgIGlzTWFya2V0T3BlbigpIHsKICAgICAgY29uc3QgcCA9IGdldEFyZ05vd1BhcnRzKCk7CiAgICAgIGNvbnN0IGJ1c2luZXNzRGF5ID0gcC53ZWVrZGF5ID49IDEgJiYgcC53ZWVrZGF5IDw9IDU7CiAgICAgIGNvbnN0IHNlY29uZHMgPSBwLmhvdXIgKiAzNjAwICsgcC5taW51dGUgKiA2MCArIHAuc2Vjb25kOwogICAgICBjb25zdCBmcm9tID0gMTAgKiAzNjAwICsgMzAgKiA2MDsKICAgICAgY29uc3QgdG8gPSAxOCAqIDM2MDA7CiAgICAgIHJldHVybiBidXNpbmVzc0RheSAmJiBzZWNvbmRzID49IGZyb20gJiYgc2Vjb25kcyA8IHRvOwogICAgfQoKICAgIGdldE5leHRSdW5UaW1lKCkgewogICAgICByZXR1cm4gdGhpcy5uZXh0UnVuQXQgPyBuZXcgRGF0ZSh0aGlzLm5leHRSdW5BdCkgOiBudWxsOwogICAgfQoKICAgIF9zY2hlZHVsZShkZWxheU1zKSB7CiAgICAgIGlmICghdGhpcy5ydW5uaW5nIHx8IHRoaXMucGF1c2VkKSByZXR1cm47CiAgICAgIGNsZWFyVGltZW91dCh0aGlzLnRpbWVyKTsKICAgICAgdGhpcy5uZXh0UnVuQXQgPSBEYXRlLm5vdygpICsgZGVsYXlNczsKICAgICAgdGhpcy50aW1lciA9IHNldFRpbWVvdXQoYXN5bmMgKCkgPT4gewogICAgICAgIGlmICghdGhpcy5ydW5uaW5nIHx8IHRoaXMucGF1c2VkKSByZXR1cm47CiAgICAgICAgaWYgKCF0aGlzLmlzTWFya2V0T3BlbigpKSB7CiAgICAgICAgICBzZXRNYXJrZXRUYWcoZmFsc2UpOwogICAgICAgICAgdGhpcy5fd2FpdEZvck9wZW4oKTsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgICAgc2V0TWFya2V0VGFnKHRydWUpOwogICAgICAgIGF3YWl0IHRoaXMuZmV0Y2hGbigpOwogICAgICAgIHRoaXMuX3NjaGVkdWxlKHRoaXMuaW50ZXJ2YWxNcyk7CiAgICAgIH0sIGRlbGF5TXMpOwogICAgfQoKICAgIF93YWl0Rm9yT3BlbigpIHsKICAgICAgaWYgKCF0aGlzLnJ1bm5pbmcgfHwgdGhpcy5wYXVzZWQpIHJldHVybjsKICAgICAgY2xlYXJUaW1lb3V0KHRoaXMud2FpdFRpbWVyKTsKICAgICAgdGhpcy5uZXh0UnVuQXQgPSBEYXRlLm5vdygpICsgNjAwMDA7CiAgICAgIHRoaXMud2FpdFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7CiAgICAgICAgaWYgKCF0aGlzLnJ1bm5pbmcgfHwgdGhpcy5wYXVzZWQpIHJldHVybjsKICAgICAgICBpZiAodGhpcy5pc01hcmtldE9wZW4oKSkgewogICAgICAgICAgc2V0TWFya2V0VGFnKHRydWUpOwogICAgICAgICAgdGhpcy5mZXRjaEZuKHsgbWFudWFsOiB0cnVlIH0pOwogICAgICAgICAgdGhpcy5fc2NoZWR1bGUodGhpcy5pbnRlcnZhbE1zKTsKICAgICAgICB9IGVsc2UgewogICAgICAgICAgc2V0TWFya2V0VGFnKGZhbHNlKTsKICAgICAgICAgIHRoaXMuX3dhaXRGb3JPcGVuKCk7CiAgICAgICAgfQogICAgICB9LCA2MDAwMCk7CiAgICB9CgogICAgX3N0YXJ0Q291bnRkb3duKCkgewogICAgICB0aGlzLl9zdG9wQ291bnRkb3duKCk7CiAgICAgIHRoaXMuY291bnRkb3duVGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7CiAgICAgICAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY291bnRkb3duLXRleHQnKTsKICAgICAgICBpZiAoIWVsIHx8IHRoaXMucGF1c2VkKSByZXR1cm47CiAgICAgICAgY29uc3QgbmV4dCA9IHRoaXMuZ2V0TmV4dFJ1blRpbWUoKTsKICAgICAgICBpZiAoIW5leHQpIHsKICAgICAgICAgIGVsLnRleHRDb250ZW50ID0gdGhpcy5pc01hcmtldE9wZW4oKSA/ICdQcsOzeGltYSBhY3R1YWxpemFjacOzbiBlbiDigJQnIDogJ01lcmNhZG8gY2VycmFkbyc7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQogICAgICAgIGNvbnN0IGRpZmYgPSBNYXRoLm1heCgwLCBuZXh0LmdldFRpbWUoKSAtIERhdGUubm93KCkpOwogICAgICAgIGNvbnN0IG0gPSBNYXRoLmZsb29yKGRpZmYgLyA2MDAwMCk7CiAgICAgICAgY29uc3QgcyA9IE1hdGguZmxvb3IoKGRpZmYgJSA2MDAwMCkgLyAxMDAwKTsKICAgICAgICBpZiAodGhpcy5pc01hcmtldE9wZW4oKSkgZWwudGV4dENvbnRlbnQgPSBgUHLDs3hpbWEgYWN0dWFsaXphY2nDs24gZW4gJHttfToke1N0cmluZyhzKS5wYWRTdGFydCgyLCAnMCcpfWA7CiAgICAgICAgZWxzZSBlbC50ZXh0Q29udGVudCA9ICdNZXJjYWRvIGNlcnJhZG8nOwogICAgICB9LCAxMDAwKTsKICAgIH0KCiAgICBfc3RvcENvdW50ZG93bigpIHsKICAgICAgY2xlYXJJbnRlcnZhbCh0aGlzLmNvdW50ZG93blRpbWVyKTsKICAgICAgdGhpcy5jb3VudGRvd25UaW1lciA9IG51bGw7CiAgICB9CiAgfQoKICAvLyA2KSBMw7NnaWNhIGRlIGNhY2jDqQogIGZ1bmN0aW9uIHNhdmVDYWNoZShkYXRhKSB7CiAgICB0cnkgewogICAgICBzZXNzaW9uU3RvcmFnZS5zZXRJdGVtKENBQ0hFX0tFWSwgSlNPTi5zdHJpbmdpZnkoewogICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSwKICAgICAgICBtZXBDY2w6IGRhdGEubWVwQ2NsCiAgICAgIH0pKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgY29uc29sZS5lcnJvcignW1JhZGFyTUVQXSBubyBzZSBwdWRvIGd1YXJkYXIgY2FjaGUnLCBlKTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIGxvYWRDYWNoZSgpIHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHJhdyA9IHNlc3Npb25TdG9yYWdlLmdldEl0ZW0oQ0FDSEVfS0VZKTsKICAgICAgaWYgKCFyYXcpIHJldHVybiBudWxsOwogICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdyk7CiAgICAgIGlmICghcGFyc2VkLnRpbWVzdGFtcCB8fCBEYXRlLm5vdygpIC0gcGFyc2VkLnRpbWVzdGFtcCA+IENBQ0hFX1RUTF9NUykgcmV0dXJuIG51bGw7CiAgICAgIHJldHVybiBwYXJzZWQ7CiAgICB9IGNhdGNoIChlKSB7CiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tSYWRhck1FUF0gY2FjaGUgaW52w6FsaWRhJywgZSk7CiAgICAgIHJldHVybiBudWxsOwogICAgfQogIH0KCiAgLy8gNykgSW5pY2lhbGl6YWNpw7NuCiAgZnVuY3Rpb24gdG9nZ2xlRHJhd2VyKCkgewogICAgY29uc3QgZHJhd2VyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2RyYXdlcicpOwogICAgY29uc3Qgd3JhcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdib2R5V3JhcCcpOwogICAgY29uc3QgYnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2J0blRhc2FzJyk7CiAgICBjb25zdCBvdmwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnb3ZlcmxheScpOwogICAgY29uc3QgaXNPcGVuID0gZHJhd2VyLmNsYXNzTGlzdC5jb250YWlucygnb3BlbicpOwogICAgZHJhd2VyLmNsYXNzTGlzdC50b2dnbGUoJ29wZW4nLCAhaXNPcGVuKTsKICAgIHdyYXAuY2xhc3NMaXN0LnRvZ2dsZSgnZHJhd2VyLW9wZW4nLCAhaXNPcGVuKTsKICAgIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKCdhY3RpdmUnLCAhaXNPcGVuKTsKICAgIG92bC5jbGFzc0xpc3QudG9nZ2xlKCdzaG93JywgIWlzT3Blbik7CiAgfQoKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcucGlsbFtkYXRhLWZpbHRlcl0nKS5mb3JFYWNoKChwKSA9PiB7CiAgICBwLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gYXBwbHlGaWx0ZXIocC5kYXRhc2V0LmZpbHRlcikpOwogIH0pOwoKICBmdW5jdGlvbiB0b2dnbGVHbG9zKCkgewogICAgY29uc3QgZ3JpZCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdnbG9zR3JpZCcpOwogICAgY29uc3QgYXJyb3cgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZ2xvc0Fycm93Jyk7CiAgICBjb25zdCBvcGVuID0gZ3JpZC5jbGFzc0xpc3QudG9nZ2xlKCdvcGVuJyk7CiAgICBhcnJvdy50ZXh0Q29udGVudCA9IG9wZW4gPyAn4pa0JyA6ICfilr4nOwogIH0KCiAgY29uc3QgcmV0cnlCdG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZXJyb3ItcmV0cnktYnRuJyk7CiAgaWYgKHJldHJ5QnRuKSB7CiAgICByZXRyeUJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgaWYgKHdpbmRvdy5zY2hlZHVsZXIpIHdpbmRvdy5zY2hlZHVsZXIucmVzdW1lKCk7CiAgICAgIGZldGNoQWxsKHsgbWFudWFsOiB0cnVlIH0pOwogICAgfSk7CiAgfQoKICBjb25zdCBjYWNoZWQgPSBsb2FkQ2FjaGUoKTsKICBpbml0SGlzdG9yeUNvbHVtbldpZHRocygpOwogIGJpbmRIaXN0b3J5Q29sdW1uUmVzaXplKCk7CiAgaWYgKGNhY2hlZCkgewogICAgc3RhdGUubGFzdE1lcFBheWxvYWQgPSBjYWNoZWQubWVwQ2NsOwogICAgcmVuZGVyTWVwQ2NsKGNhY2hlZC5tZXBDY2wpOwogICAgcmVuZGVyTWV0cmljczI0aChjYWNoZWQubWVwQ2NsKTsKICAgIHJlbmRlclRyZW5kKGNhY2hlZC5tZXBDY2wpOwogICAgcmVuZGVySGlzdG9yeShjYWNoZWQubWVwQ2NsKTsKICAgIHNldEZyZXNoQmFkZ2UoYERhdG8gZW4gY2FjaMOpIMK3ICR7Zm10QXJnVGltZS5mb3JtYXQobmV3IERhdGUoY2FjaGVkLnRpbWVzdGFtcCkpfWAsICdpZGxlJyk7CiAgfQoKICBhcHBseUZpbHRlcihzdGF0ZS5maWx0ZXJNb2RlKTsKCiAgd2luZG93LnNjaGVkdWxlciA9IG5ldyBNYXJrZXRTY2hlZHVsZXIoZmV0Y2hBbGwsIEZFVENIX0lOVEVSVkFMX01TKTsKICB3aW5kb3cuc2NoZWR1bGVyLnN0YXJ0KCk7CiAgZmV0Y2hBbGwoeyBtYW51YWw6IHRydWUgfSk7CgogIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ3Zpc2liaWxpdHljaGFuZ2UnLCAoKSA9PiB7CiAgICBpZiAoZG9jdW1lbnQuaGlkZGVuKSB3aW5kb3cuc2NoZWR1bGVyLnBhdXNlKCk7CiAgICBlbHNlIHdpbmRvdy5zY2hlZHVsZXIucmVzdW1lKCk7CiAgfSk7Cjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4K`;

function decodeBase64Utf8(b64) {
  const compact = b64.replace(/\s+/g, "");
  const binary = atob(compact);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function renderDashboardHtml() {
  return decodeBase64Utf8(DASHBOARD_HTML_B64);
}
