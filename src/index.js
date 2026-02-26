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

const DASHBOARD_HTML_B64 = `PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVzIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAiPgo8dGl0bGU+UmFkYXIgTUVQL0NDTCDCtyBNZXJjYWRvIEFSRzwvdGl0bGU+CjxsaW5rIHJlbD0icHJlY29ubmVjdCIgaHJlZj0iaHR0cHM6Ly9mb250cy5nb29nbGVhcGlzLmNvbSI+CjxsaW5rIGhyZWY9Imh0dHBzOi8vZm9udHMuZ29vZ2xlYXBpcy5jb20vY3NzMj9mYW1pbHk9U3BhY2UrTW9ubzp3Z2h0QDQwMDs3MDAmZmFtaWx5PVN5bmU6d2dodEA0MDA7NjAwOzcwMDs4MDAmZGlzcGxheT1zd2FwIiByZWw9InN0eWxlc2hlZXQiPgo8c3R5bGU+Ci8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBUT0tFTlMK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCjpyb290IHsKICAtLWJnOiAgICAgICAjMDgwYjBlOwogIC0tc3VyZjogICAgICMwZjEzMTg7CiAgLS1zdXJmMjogICAgIzE2MWIyMjsKICAtLXN1cmYzOiAgICAjMWMyMzMwOwogIC0tYm9yZGVyOiAgICMxZTI1MzA7CiAgLS1ib3JkZXJCOiAgIzJhMzQ0NDsKCiAgLS1ncmVlbjogICAgIzAwZTY3NjsKICAtLWdyZWVuLWQ6ICByZ2JhKDAsMjMwLDExOCwuMDkpOwogIC0tZ3JlZW4tZzogIHJnYmEoMCwyMzAsMTE4LC4yMik7CiAgLS1yZWQ6ICAgICAgI2ZmNDc1NzsKICAtLXJlZC1kOiAgICByZ2JhKDI1NSw3MSw4NywuMDkpOwogIC0teWVsbG93OiAgICNmZmMgYzAwOwogIC0teWVsbG93OiAgICNmZmNjMDA7CiAgLS15ZWxsb3ctZDogcmdiYSgyNTUsMjA0LDAsLjA5KTsKCiAgLS1tZXA6ICAgICAgIzI5YjZmNjsKICAtLWNjbDogICAgICAjYjM5ZGRiOwogIC0tdGV4dDogICAgICNkZGU0ZWU7CiAgLS1tdXRlZDogICAgIzU1NjA3MDsKICAtLW11dGVkMjogICAjN2E4ZmE4OwoKICAtLW1vbm86ICdTcGFjZSBNb25vJywgbW9ub3NwYWNlOwogIC0tc2FuczogJ1N5bmUnLCBzYW5zLXNlcmlmOwoKICAtLWRyYXdlci13OiA0MDBweDsKICAtLWhlYWRlci1oOiA1NHB4Owp9CgoqLCAqOjpiZWZvcmUsICo6OmFmdGVyIHsgYm94LXNpemluZzogYm9yZGVyLWJveDsgbWFyZ2luOiAwOyBwYWRkaW5nOiAwOyB9CgpodG1sIHsgc2Nyb2xsLWJlaGF2aW9yOiBzbW9vdGg7IH0KCmJvZHkgewogIGJhY2tncm91bmQ6IHZhcigtLWJnKTsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgZm9udC1mYW1pbHk6IHZhcigtLW1vbm8pOwogIG1pbi1oZWlnaHQ6IDEwMHZoOwogIG92ZXJmbG93LXg6IGhpZGRlbjsKfQoKYm9keTo6YmVmb3JlIHsKICBjb250ZW50OiAnJzsKICBwb3NpdGlvbjogZml4ZWQ7IGluc2V0OiAwOwogIGJhY2tncm91bmQtaW1hZ2U6CiAgICBsaW5lYXItZ3JhZGllbnQocmdiYSg0MSwxODIsMjQ2LC4wMjUpIDFweCwgdHJhbnNwYXJlbnQgMXB4KSwKICAgIGxpbmVhci1ncmFkaWVudCg5MGRlZywgcmdiYSg0MSwxODIsMjQ2LC4wMjUpIDFweCwgdHJhbnNwYXJlbnQgMXB4KTsKICBiYWNrZ3JvdW5kLXNpemU6IDQ0cHggNDRweDsKICBwb2ludGVyLWV2ZW50czogbm9uZTsgei1pbmRleDogMDsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIExBWU9VVCBTSEVMTArilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLmFwcCB7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBtaW4taGVpZ2h0OiAxMDB2aDsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIEhFQURFUgrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KaGVhZGVyIHsKICBwb3NpdGlvbjogc3RpY2t5OyB0b3A6IDA7IHotaW5kZXg6IDIwMDsKICBoZWlnaHQ6IHZhcigtLWhlYWRlci1oKTsKICBiYWNrZ3JvdW5kOiByZ2JhKDgsMTEsMTQsLjkzKTsKICBiYWNrZHJvcC1maWx0ZXI6IGJsdXIoMThweCk7CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgcGFkZGluZzogMCAyMnB4OwogIGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsKfQoKLmxvZ28gewogIGZvbnQtZmFtaWx5OiB2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6IDgwMDsgZm9udC1zaXplOiAxNXB4OwogIGxldHRlci1zcGFjaW5nOiAuMDVlbTsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA5cHg7Cn0KCi5saXZlLWRvdCB7CiAgd2lkdGg6IDdweDsgaGVpZ2h0OiA3cHg7IGJvcmRlci1yYWRpdXM6IDUwJTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1ncmVlbik7CiAgYm94LXNoYWRvdzogMCAwIDhweCB2YXIoLS1ncmVlbik7CiAgYW5pbWF0aW9uOiBibGluayAyLjJzIGVhc2UtaW4tb3V0IGluZmluaXRlOwp9CkBrZXlmcmFtZXMgYmxpbmsgewogIDAlLDEwMCV7b3BhY2l0eToxO2JveC1zaGFkb3c6MCAwIDhweCB2YXIoLS1ncmVlbik7fQogIDUwJXtvcGFjaXR5Oi4zNTtib3gtc2hhZG93OjAgMCAzcHggdmFyKC0tZ3JlZW4pO30KfQoKLmhlYWRlci1yaWdodCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMTJweDsgfQoKLmZyZXNoLWJhZGdlIHsKICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDVweDsKICBmb250LXNpemU6IDExcHg7IGNvbG9yOiB2YXIoLS1tdXRlZDIpOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYyKTsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOiAyMHB4OyBwYWRkaW5nOiAzcHggMTFweDsKfQouZnJlc2gtZG90IHsgd2lkdGg6NXB4O2hlaWdodDo1cHg7Ym9yZGVyLXJhZGl1czo1MCU7YmFja2dyb3VuZDp2YXIoLS1ncmVlbik7YW5pbWF0aW9uOmJsaW5rIDIuMnMgZWFzZS1pbi1vdXQgaW5maW5pdGU7IH0KLmZyZXNoLWJhZGdlLmZldGNoaW5nIHsgYW5pbWF0aW9uOiBiYWRnZVB1bHNlIDEuMnMgZWFzZS1pbi1vdXQgaW5maW5pdGU7IH0KLmZyZXNoLWJhZGdlLmVycm9yIHsgY29sb3I6I2ZmZDBkMDsgYm9yZGVyLWNvbG9yOnJnYmEoMjU1LDgyLDgyLC40NSk7IGJhY2tncm91bmQ6cmdiYSgyNTUsODIsODIsLjEyKTsgY3Vyc29yOnBvaW50ZXI7IH0KQGtleWZyYW1lcyBiYWRnZVB1bHNlIHsKICAwJSwxMDAlIHsgb3BhY2l0eToxOyB9CiAgNTAlIHsgb3BhY2l0eTouNjU7IH0KfQoKLnRhZy1tZXJjYWRvIHsKICBmb250LWZhbWlseTogdmFyKC0tc2Fucyk7IGZvbnQtc2l6ZToxMHB4OyBmb250LXdlaWdodDo3MDA7CiAgbGV0dGVyLXNwYWNpbmc6LjA4ZW07IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsKICBiYWNrZ3JvdW5kOnZhcigtLWdyZWVuKTsgY29sb3I6IzAwMDsKICBwYWRkaW5nOjNweCA5cHg7IGJvcmRlci1yYWRpdXM6NHB4Owp9Ci50YWctbWVyY2Fkby5jbG9zZWQgeyBiYWNrZ3JvdW5kOnZhcigtLW11dGVkKTsgY29sb3I6IzBhMGMwZjsgfQoKLmJ0biB7CiAgZm9udC1mYW1pbHk6IHZhcigtLXNhbnMpOyBmb250LXNpemU6MTFweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4wN2VtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7CiAgYm9yZGVyLXJhZGl1czo2cHg7IHBhZGRpbmc6NnB4IDE0cHg7IGN1cnNvcjpwb2ludGVyOwogIGJvcmRlcjpub25lOyB0cmFuc2l0aW9uOiBhbGwgLjE4czsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo2cHg7Cn0KLmJ0bi1hbGVydCB7IGJhY2tncm91bmQ6dmFyKC0tZ3JlZW4pOyBjb2xvcjojMDAwOyB9Ci5idG4tYWxlcnQ6aG92ZXIgeyBiYWNrZ3JvdW5kOiMwMGZmODg7IHRyYW5zZm9ybTp0cmFuc2xhdGVZKC0xcHgpOyB9CgouYnRuLXRhc2FzIHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMik7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyQik7CiAgY29sb3I6IHZhcigtLXRleHQpOwp9Ci5idG4tdGFzYXM6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMyk7IGJvcmRlci1jb2xvcjogdmFyKC0tbXV0ZWQyKTsgfQouYnRuLXRhc2FzLmFjdGl2ZSB7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZjMpOwogIGJvcmRlci1jb2xvcjogdmFyKC0teWVsbG93KTsKICBjb2xvcjogdmFyKC0teWVsbG93KTsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIE1BSU4gKyBEUkFXRVIgTEFZT1VUCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwouYm9keS13cmFwIHsKICBmbGV4OiAxOwogIGRpc3BsYXk6IGZsZXg7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIHotaW5kZXg6IDE7CiAgdHJhbnNpdGlvbjogbm9uZTsKfQoKLm1haW4tY29udGVudCB7CiAgZmxleDogMTsKICBtYXgtd2lkdGg6IDEwMCU7CiAgcGFkZGluZzogMjJweCAyMnB4IDYwcHg7CiAgdHJhbnNpdGlvbjogbWFyZ2luLXJpZ2h0IC4zNXMgY3ViaWMtYmV6aWVyKC40LDAsLjIsMSk7Cn0KCi5ib2R5LXdyYXAuZHJhd2VyLW9wZW4gLm1haW4tY29udGVudCB7CiAgbWFyZ2luLXJpZ2h0OiB2YXIoLS1kcmF3ZXItdyk7Cn0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBEUkFXRVIK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5kcmF3ZXIgewogIHBvc2l0aW9uOiBmaXhlZDsKICB0b3A6IHZhcigtLWhlYWRlci1oKTsKICByaWdodDogMDsKICB3aWR0aDogdmFyKC0tZHJhd2VyLXcpOwogIGhlaWdodDogY2FsYygxMDB2aCAtIHZhcigtLWhlYWRlci1oKSk7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZik7CiAgYm9yZGVyLWxlZnQ6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIHRyYW5zZm9ybTogdHJhbnNsYXRlWCgxMDAlKTsKICB0cmFuc2l0aW9uOiB0cmFuc2Zvcm0gLjM1cyBjdWJpYy1iZXppZXIoLjQsMCwuMiwxKTsKICBvdmVyZmxvdy15OiBhdXRvOwogIHotaW5kZXg6IDE1MDsKICBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwp9CgouZHJhd2VyLm9wZW4geyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVgoMCk7IH0KCi5kcmF3ZXItaGVhZGVyIHsKICBwb3NpdGlvbjogc3RpY2t5OyB0b3A6IDA7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZik7CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgcGFkZGluZzogMTZweCAyMHB4OwogIGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsKICB6LWluZGV4OiAxMDsKfQoKLmRyYXdlci10aXRsZSB7CiAgZm9udC1mYW1pbHk6IHZhcigtLXNhbnMpOyBmb250LXdlaWdodDogODAwOyBmb250LXNpemU6IDEzcHg7CiAgbGV0dGVyLXNwYWNpbmc6LjA0ZW07IGNvbG9yOiB2YXIoLS10ZXh0KTsKICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo4cHg7Cn0KCi5kcmF3ZXItc291cmNlIHsKICBmb250LXNpemU6MTBweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBmb250LWZhbWlseTp2YXIoLS1tb25vKTsKfQoKLmJ0bi1jbG9zZSB7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmMik7IGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBjb2xvcjp2YXIoLS1tdXRlZDIpOyBib3JkZXItcmFkaXVzOjZweDsgcGFkZGluZzo1cHggMTBweDsKICBjdXJzb3I6cG9pbnRlcjsgZm9udC1zaXplOjEzcHg7IHRyYW5zaXRpb246IGFsbCAuMTVzOwp9Ci5idG4tY2xvc2U6aG92ZXIgeyBjb2xvcjp2YXIoLS10ZXh0KTsgYm9yZGVyLWNvbG9yOnZhcigtLW11dGVkMik7IH0KCi5kcmF3ZXItYm9keSB7IHBhZGRpbmc6IDE2cHggMjBweDsgZGlzcGxheTogZmxleDsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgZ2FwOiAyMnB4OyB9CgouY29udGV4dC1ib3ggewogIGJhY2tncm91bmQ6IHJnYmEoMjU1LDIwNCwwLC4wNik7CiAgYm9yZGVyOiAxcHggc29saWQgcmdiYSgyNTUsMjA0LDAsLjIpOwogIGJvcmRlci1yYWRpdXM6IDlweDsKICBwYWRkaW5nOiAxM3B4IDE1cHg7CiAgZm9udC1zaXplOiAxMXB4OwogIGxpbmUtaGVpZ2h0OjEuNjU7CiAgY29sb3I6dmFyKC0tbXV0ZWQyKTsKfQouY29udGV4dC1ib3ggc3Ryb25nIHsgY29sb3I6dmFyKC0teWVsbG93KTsgfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIFNUQVRVUyBCQU5ORVIK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5zdGF0dXMtYmFubmVyIHsKICBib3JkZXItcmFkaXVzOjExcHg7IHBhZGRpbmc6MThweCAyNHB4OyBtYXJnaW4tYm90dG9tOjIwcHg7CiAgYm9yZGVyOjFweCBzb2xpZDsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47CiAgYW5pbWF0aW9uOmZhZGVJbiAuNHMgZWFzZTsKICBvdmVyZmxvdzpoaWRkZW47IHBvc2l0aW9uOnJlbGF0aXZlOwp9Ci5zdGF0dXMtYmFubmVyLnNpbWlsYXIgewogIGJhY2tncm91bmQ6dmFyKC0tZ3JlZW4tZCk7IGJvcmRlci1jb2xvcjpyZ2JhKDAsMjMwLDExOCwuMjgpOwp9Ci5zdGF0dXMtYmFubmVyLnNpbWlsYXI6OmFmdGVyIHsKICBjb250ZW50OicnOyBwb3NpdGlvbjphYnNvbHV0ZTsgcmlnaHQ6LTUwcHg7IHRvcDo1MCU7CiAgdHJhbnNmb3JtOnRyYW5zbGF0ZVkoLTUwJSk7IHdpZHRoOjIwMHB4OyBoZWlnaHQ6MjAwcHg7CiAgYm9yZGVyLXJhZGl1czo1MCU7CiAgYmFja2dyb3VuZDpyYWRpYWwtZ3JhZGllbnQoY2lyY2xlLHZhcigtLWdyZWVuLWcpIDAlLHRyYW5zcGFyZW50IDcwJSk7CiAgcG9pbnRlci1ldmVudHM6bm9uZTsKfQouc3RhdHVzLWJhbm5lci5uby1zaW1pbGFyIHsKICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSw4Miw4MiwuMDgpOwogIGJvcmRlci1jb2xvcjogcmdiYSgyNTUsODIsODIsLjM1KTsKfQouc3RhdHVzLWJhbm5lci5uby1zaW1pbGFyOjphZnRlciB7CiAgY29udGVudDonJzsKICBwb3NpdGlvbjphYnNvbHV0ZTsKICByaWdodDotNTBweDsKICB0b3A6NTAlOwogIHRyYW5zZm9ybTp0cmFuc2xhdGVZKC01MCUpOwogIHdpZHRoOjIwMHB4OwogIGhlaWdodDoyMDBweDsKICBib3JkZXItcmFkaXVzOjUwJTsKICBiYWNrZ3JvdW5kOnJhZGlhbC1ncmFkaWVudChjaXJjbGUscmdiYSgyNTUsODIsODIsLjE4KSAwJSx0cmFuc3BhcmVudCA3MCUpOwogIHBvaW50ZXItZXZlbnRzOm5vbmU7Cn0KCi5zLWxlZnQge30KLnMtdGl0bGUgewogIGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXdlaWdodDo4MDA7IGZvbnQtc2l6ZToyNnB4OwogIGxldHRlci1zcGFjaW5nOi0uMDJlbTsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDoxMnB4Owp9Ci5zLWJhZGdlIHsKICBmb250LXNpemU6MTBweDsgZm9udC13ZWlnaHQ6NzAwOyBsZXR0ZXItc3BhY2luZzouMWVtOwogIHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsgcGFkZGluZzoycHggOXB4OyBib3JkZXItcmFkaXVzOjRweDsKICBiYWNrZ3JvdW5kOnZhcigtLWdyZWVuKTsgY29sb3I6IzAwMDsgYWxpZ24tc2VsZjpjZW50ZXI7Cn0KLnMtYmFkZ2Uubm9zaW0geyBiYWNrZ3JvdW5kOiB2YXIoLS1yZWQpOyBjb2xvcjogI2ZmZjsgfQoucy1zdWIgeyBmb250LXNpemU6MTFweDsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgbWFyZ2luLXRvcDo0cHg7IH0KCi5lcnJvci1iYW5uZXIgewogIGRpc3BsYXk6bm9uZTsKICBtYXJnaW46IDAgMCAxNHB4IDA7CiAgcGFkZGluZzogMTBweCAxMnB4OwogIGJvcmRlci1yYWRpdXM6IDhweDsKICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDI1NSw4Miw4MiwuNDUpOwogIGJhY2tncm91bmQ6IHJnYmEoMjU1LDgyLDgyLC4xMik7CiAgY29sb3I6ICNmZmQwZDA7CiAgZm9udC1zaXplOiAxMXB4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuOwogIGdhcDogMTBweDsKfQouZXJyb3ItYmFubmVyLnNob3cgeyBkaXNwbGF5OmZsZXg7IH0KLmVycm9yLWJhbm5lciBidXR0b24gewogIGJvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsODIsODIsLjUpOwogIGJhY2tncm91bmQ6IHJnYmEoMjU1LDgyLDgyLC4xNSk7CiAgY29sb3I6I2ZmZGVkZTsKICBib3JkZXItcmFkaXVzOjZweDsKICBwYWRkaW5nOjRweCAxMHB4OwogIGZvbnQtc2l6ZToxMHB4OwogIGZvbnQtd2VpZ2h0OjcwMDsKICB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7CiAgbGV0dGVyLXNwYWNpbmc6LjA2ZW07CiAgY3Vyc29yOnBvaW50ZXI7Cn0KCi5za2VsZXRvbiB7CiAgYmFja2dyb3VuZDogbGluZWFyLWdyYWRpZW50KDkwZGVnLCAjMWMyMzMwIDI1JSwgIzJhMzQ0NCA1MCUsICMxYzIzMzAgNzUlKTsKICBiYWNrZ3JvdW5kLXNpemU6IDIwMCUgMTAwJTsKICBhbmltYXRpb246IHNoaW1tZXIgMS40cyBpbmZpbml0ZTsKICBib3JkZXItcmFkaXVzOiA0cHg7CiAgY29sb3I6IHRyYW5zcGFyZW50OwogIHVzZXItc2VsZWN0OiBub25lOwp9CkBrZXlmcmFtZXMgc2hpbW1lciB7CiAgMCUgICB7IGJhY2tncm91bmQtcG9zaXRpb246IDIwMCUgMDsgfQogIDEwMCUgeyBiYWNrZ3JvdW5kLXBvc2l0aW9uOiAtMjAwJSAwOyB9Cn0KCi52YWx1ZS1jaGFuZ2VkIHsKICBhbmltYXRpb246IGZsYXNoVmFsdWUgNjAwbXMgZWFzZTsKfQpAa2V5ZnJhbWVzIGZsYXNoVmFsdWUgewogIDAlICAgeyBjb2xvcjogI2ZmY2MwMDsgfQogIDEwMCUgeyBjb2xvcjogaW5oZXJpdDsgfQp9Cgoucy1yaWdodCB7IHRleHQtYWxpZ246cmlnaHQ7IGZvbnQtc2l6ZToxMXB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7IGxpbmUtaGVpZ2h0OjEuOTsgfQoucy1yaWdodCBzdHJvbmcgeyBjb2xvcjp2YXIoLS1tdXRlZDIpOyB9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgSEVSTyBDQVJEUwrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLmhlcm8tZ3JpZCB7CiAgZGlzcGxheTpncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmciAxZnI7CiAgZ2FwOjE0cHg7IG1hcmdpbi1ib3R0b206MjBweDsKfQoKLmhjYXJkIHsKICBiYWNrZ3JvdW5kOnZhcigtLXN1cmYpOyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czoxMXB4OyBwYWRkaW5nOjIwcHggMjJweDsKICBwb3NpdGlvbjpyZWxhdGl2ZTsgb3ZlcmZsb3c6aGlkZGVuOwogIHRyYW5zaXRpb246Ym9yZGVyLWNvbG9yIC4xOHM7CiAgYW5pbWF0aW9uOiBmYWRlVXAgLjVzIGVhc2UgYm90aDsKfQouaGNhcmQ6bnRoLWNoaWxkKDEpe2FuaW1hdGlvbi1kZWxheTouMDhzO30KLmhjYXJkOm50aC1jaGlsZCgyKXthbmltYXRpb24tZGVsYXk6LjE2czt9Ci5oY2FyZDpudGgtY2hpbGQoMyl7YW5pbWF0aW9uLWRlbGF5Oi4yNHM7fQouaGNhcmQ6aG92ZXIgeyBib3JkZXItY29sb3I6dmFyKC0tYm9yZGVyQik7IH0KCi5oY2FyZCAuYmFyIHsgcG9zaXRpb246YWJzb2x1dGU7IHRvcDowO2xlZnQ6MDtyaWdodDowOyBoZWlnaHQ6MnB4OyB9Ci5oY2FyZC5tZXAgLmJhciB7IGJhY2tncm91bmQ6dmFyKC0tbWVwKTsgfQouaGNhcmQuY2NsIC5iYXIgeyBiYWNrZ3JvdW5kOnZhcigtLWNjbCk7IH0KLmhjYXJkLmdhcCAuYmFyIHsgYmFja2dyb3VuZDp2YXIoLS15ZWxsb3cpOyB9CgouaGNhcmQtbGFiZWwgewogIGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXNpemU6MTBweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4xMmVtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7IGNvbG9yOnZhcigtLW11dGVkKTsKICBtYXJnaW4tYm90dG9tOjlweDsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo1cHg7Cn0KLmhjYXJkLWxhYmVsIC5kb3QgeyB3aWR0aDo1cHg7aGVpZ2h0OjVweDtib3JkZXItcmFkaXVzOjUwJTsgfQoubWVwIC5kb3R7YmFja2dyb3VuZDp2YXIoLS1tZXApO30KLmNjbCAuZG90e2JhY2tncm91bmQ6dmFyKC0tY2NsKTt9Ci5nYXAgLmRvdHtiYWNrZ3JvdW5kOnZhcigtLXllbGxvdyk7fQoKLmhjYXJkLXZhbCB7CiAgZm9udC1zaXplOjM0cHg7IGZvbnQtd2VpZ2h0OjcwMDsgbGV0dGVyLXNwYWNpbmc6LS4wMmVtOyBsaW5lLWhlaWdodDoxOwp9Ci5tZXAgLmhjYXJkLXZhbHtjb2xvcjp2YXIoLS1tZXApO30KLmNjbCAuaGNhcmQtdmFse2NvbG9yOnZhcigtLWNjbCk7fQoKLmhjYXJkLXBjdCB7IGZvbnQtc2l6ZToyMHB4OyBjb2xvcjp2YXIoLS15ZWxsb3cpOyBmb250LXdlaWdodDo3MDA7IG1hcmdpbi10b3A6M3B4OyB9Ci5oY2FyZC1zdWIgeyBmb250LXNpemU6MTBweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBtYXJnaW4tdG9wOjdweDsgfQoKLyogdG9vbHRpcCAqLwoudGlwIHsgcG9zaXRpb246cmVsYXRpdmU7IGN1cnNvcjpoZWxwOyB9Ci50aXA6OmFmdGVyIHsKICBjb250ZW50OmF0dHIoZGF0YS10KTsKICBwb3NpdGlvbjphYnNvbHV0ZTsgYm90dG9tOmNhbGMoMTAwJSArIDdweCk7IGxlZnQ6NTAlOwogIHRyYW5zZm9ybTp0cmFuc2xhdGVYKC01MCUpOwogIGJhY2tncm91bmQ6IzFhMjIzMjsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXJCKTsKICBjb2xvcjp2YXIoLS10ZXh0KTsgZm9udC1zaXplOjEwcHg7IHBhZGRpbmc6NXB4IDlweDsKICBib3JkZXItcmFkaXVzOjZweDsgd2hpdGUtc3BhY2U6bm93cmFwOwogIG9wYWNpdHk6MDsgcG9pbnRlci1ldmVudHM6bm9uZTsgdHJhbnNpdGlvbjpvcGFjaXR5IC4xOHM7IHotaW5kZXg6OTk7Cn0KLnRpcDpob3Zlcjo6YWZ0ZXJ7b3BhY2l0eToxO30KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBDSEFSVArilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLmNoYXJ0LWNhcmQgewogIGJhY2tncm91bmQ6dmFyKC0tc3VyZik7IGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOjExcHg7IHBhZGRpbmc6MjJweDsgbWFyZ2luLWJvdHRvbToyMHB4OwogIGFuaW1hdGlvbjpmYWRlVXAgLjVzIC4zMnMgZWFzZSBib3RoOwp9Ci5jaGFydC10b3AgewogIGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjsKICBtYXJnaW4tYm90dG9tOjE2cHg7Cn0KLmNoYXJ0LXR0bCB7IGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXdlaWdodDo3MDA7IGZvbnQtc2l6ZToxM3B4OyB9CgoucGlsbHMgeyBkaXNwbGF5OmZsZXg7IGdhcDo1cHg7IH0KLnBpbGwgewogIGZvbnQtc2l6ZToxMHB4OyBwYWRkaW5nOjNweCAxMXB4OyBib3JkZXItcmFkaXVzOjIwcHg7CiAgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXJCKTsgY29sb3I6dmFyKC0tbXV0ZWQyKTsKICBiYWNrZ3JvdW5kOnRyYW5zcGFyZW50OyBjdXJzb3I6cG9pbnRlcjsgZm9udC1mYW1pbHk6dmFyKC0tbW9ubyk7CiAgdHJhbnNpdGlvbjphbGwgLjEzczsKfQoucGlsbC5vbiB7IGJhY2tncm91bmQ6dmFyKC0tbWVwKTsgYm9yZGVyLWNvbG9yOnZhcigtLW1lcCk7IGNvbG9yOiMwMDA7IGZvbnQtd2VpZ2h0OjcwMDsgfQoKLmxlZ2VuZHMgeyBkaXNwbGF5OmZsZXg7IGdhcDoxOHB4OyBtYXJnaW4tYm90dG9tOjE0cHg7IGZvbnQtc2l6ZToxMHB4OyBjb2xvcjp2YXIoLS1tdXRlZDIpOyB9Ci5sZWcgeyBkaXNwbGF5OmZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsgZ2FwOjVweDsgfQoubGVnLWxpbmUgeyB3aWR0aDoxOHB4OyBoZWlnaHQ6MnB4OyBib3JkZXItcmFkaXVzOjJweDsgfQoKc3ZnLmNoYXJ0IHsgd2lkdGg6MTAwJTsgaGVpZ2h0OjE3MHB4OyBvdmVyZmxvdzp2aXNpYmxlOyB9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgTUVUUklDUwrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLm1ldHJpY3MtZ3JpZCB7CiAgZGlzcGxheTpncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDQsMWZyKTsKICBnYXA6MTJweDsgbWFyZ2luLWJvdHRvbToyMHB4Owp9Ci5tY2FyZCB7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmMik7IGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOjlweDsgcGFkZGluZzoxNHB4IDE2cHg7CiAgYW5pbWF0aW9uOmZhZGVVcCAuNXMgZWFzZSBib3RoOwp9Ci5tY2FyZDpudGgtY2hpbGQoMSl7YW5pbWF0aW9uLWRlbGF5Oi4zOHM7fQoubWNhcmQ6bnRoLWNoaWxkKDIpe2FuaW1hdGlvbi1kZWxheTouNDNzO30KLm1jYXJkOm50aC1jaGlsZCgzKXthbmltYXRpb24tZGVsYXk6LjQ4czt9Ci5tY2FyZDpudGgtY2hpbGQoNCl7YW5pbWF0aW9uLWRlbGF5Oi41M3M7fQoubWNhcmQtbGFiZWwgewogIGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXNpemU6OXB4OyBmb250LXdlaWdodDo3MDA7CiAgbGV0dGVyLXNwYWNpbmc6LjFlbTsgdGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOyBjb2xvcjp2YXIoLS1tdXRlZCk7IG1hcmdpbi1ib3R0b206N3B4Owp9Ci5tY2FyZC12YWwgeyBmb250LXNpemU6MjBweDsgZm9udC13ZWlnaHQ6NzAwOyB9Ci5tY2FyZC1zdWIgeyBmb250LXNpemU6OXB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7IG1hcmdpbi10b3A6M3B4OyB9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgVEFCTEUK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi50YWJsZS1jYXJkIHsKICBiYWNrZ3JvdW5kOnZhcigtLXN1cmYpOyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czoxMXB4OyBvdmVyZmxvdzpoaWRkZW47CiAgYW5pbWF0aW9uOmZhZGVVcCAuNXMgLjU2cyBlYXNlIGJvdGg7Cn0KLnRhYmxlLXRvcCB7CiAgcGFkZGluZzoxNHB4IDIycHg7IGJvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGp1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuOwp9Ci50YWJsZS10dGwgeyBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6NzAwOyBmb250LXNpemU6MTNweDsgfQoudGFibGUtY2FwIHsgZm9udC1zaXplOjEwcHg7IGNvbG9yOnZhcigtLW11dGVkKTsgfQoKLmhpc3RvcnktdGFibGUtd3JhcCB7IG92ZXJmbG93LXg6YXV0bzsgfQouaGlzdG9yeS10YWJsZS13cmFwIHRhYmxlIHsKICBtaW4td2lkdGg6IDg2MHB4Owp9CnRhYmxlIHsgd2lkdGg6MTAwJTsgYm9yZGVyLWNvbGxhcHNlOmNvbGxhcHNlOyB0YWJsZS1sYXlvdXQ6Zml4ZWQ7IH0KdGhlYWQgdGggewogIGZvbnQtc2l6ZTo5cHg7IGxldHRlci1zcGFjaW5nOi4xZW07IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsKICBjb2xvcjp2YXIoLS1tdXRlZCk7IHBhZGRpbmc6OXB4IDIycHg7IHRleHQtYWxpZ246bGVmdDsKICBiYWNrZ3JvdW5kOnZhcigtLXN1cmYyKTsgZm9udC1mYW1pbHk6dmFyKC0tc2Fucyk7IGZvbnQtd2VpZ2h0OjYwMDsKICBwb3NpdGlvbjpyZWxhdGl2ZTsKfQp0Ym9keSB0ciB7IGJvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7IHRyYW5zaXRpb246YmFja2dyb3VuZCAuMTJzOyB9CnRib2R5IHRyOmhvdmVyIHsgYmFja2dyb3VuZDpyZ2JhKDQxLDE4MiwyNDYsLjA0KTsgfQp0Ym9keSB0cjpsYXN0LWNoaWxkIHsgYm9yZGVyLWJvdHRvbTpub25lOyB9CnRib2R5IHRkIHsKICBwYWRkaW5nOjExcHggMjJweDsgZm9udC1zaXplOjEycHg7CiAgb3ZlcmZsb3c6aGlkZGVuOyB0ZXh0LW92ZXJmbG93OmVsbGlwc2lzOyB3aGl0ZS1zcGFjZTpub3dyYXA7Cn0KdGQuZGltIHsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgZm9udC1zaXplOjExcHg7IH0KdGQuZGltIC50cy1kYXkgeyBmb250LXNpemU6OXB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7IGxpbmUtaGVpZ2h0OjEuMTsgfQp0ZC5kaW0gLnRzLWhvdXIgeyBmb250LXNpemU6MTFweDsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgbGluZS1oZWlnaHQ6MS4yOyBtYXJnaW4tdG9wOjJweDsgfQouY29sLWxhYmVsIHsgcGFkZGluZy1yaWdodDoxMHB4OyBkaXNwbGF5OmlubGluZS1ibG9jazsgfQouY29sLXJlc2l6ZXIgewogIHBvc2l0aW9uOmFic29sdXRlOwogIHRvcDowOwogIHJpZ2h0Oi00cHg7CiAgd2lkdGg6OHB4OwogIGhlaWdodDoxMDAlOwogIGN1cnNvcjpjb2wtcmVzaXplOwogIHVzZXItc2VsZWN0Om5vbmU7CiAgdG91Y2gtYWN0aW9uOm5vbmU7CiAgei1pbmRleDoyOwp9Ci5jb2wtcmVzaXplcjo6YWZ0ZXIgewogIGNvbnRlbnQ6Jyc7CiAgcG9zaXRpb246YWJzb2x1dGU7CiAgdG9wOjZweDsKICBib3R0b206NnB4OwogIGxlZnQ6M3B4OwogIHdpZHRoOjFweDsKICBiYWNrZ3JvdW5kOnJnYmEoMTIyLDE0MywxNjgsLjI4KTsKfQouY29sLXJlc2l6ZXI6aG92ZXI6OmFmdGVyLAouY29sLXJlc2l6ZXIuYWN0aXZlOjphZnRlciB7CiAgYmFja2dyb3VuZDpyZ2JhKDEyMiwxNDMsMTY4LC43NSk7Cn0KCi5zYmFkZ2UgewogIGRpc3BsYXk6aW5saW5lLWJsb2NrOyBmb250LXNpemU6OXB4OyBmb250LXdlaWdodDo3MDA7CiAgbGV0dGVyLXNwYWNpbmc6LjA4ZW07IHBhZGRpbmc6MnB4IDdweDsgYm9yZGVyLXJhZGl1czo0cHg7CiAgdGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOwp9Ci5zYmFkZ2Uuc2ltIHsgYmFja2dyb3VuZDp2YXIoLS1ncmVlbi1kKTsgY29sb3I6dmFyKC0tZ3JlZW4pOyBib3JkZXI6MXB4IHNvbGlkIHJnYmEoMCwyMzAsMTE4LC4yKTsgfQouc2JhZGdlLm5vc2ltIHsgYmFja2dyb3VuZDp2YXIoLS1yZWQtZCk7IGNvbG9yOnZhcigtLXJlZCk7IGJvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsNzEsODcsLjIpOyB9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgRk9PVEVSIC8gR0xPU0FSSU8K4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5nbG9zYXJpbyB7CiAgbWFyZ2luLXRvcDoyMHB4OyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czoxMXB4OyBvdmVyZmxvdzpoaWRkZW47CiAgYW5pbWF0aW9uOmZhZGVVcCAuNXMgLjZzIGVhc2UgYm90aDsKfQouZ2xvcy1idG4gewogIHdpZHRoOjEwMCU7IGJhY2tncm91bmQ6dmFyKC0tc3VyZik7IGJvcmRlcjpub25lOwogIGNvbG9yOnZhcigtLW11dGVkMik7IGZvbnQtZmFtaWx5OnZhcigtLW1vbm8pOyBmb250LXNpemU6MTFweDsKICBwYWRkaW5nOjEzcHggMjJweDsgdGV4dC1hbGlnbjpsZWZ0OyBjdXJzb3I6cG9pbnRlcjsKICBkaXNwbGF5OmZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsganVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47CiAgdHJhbnNpdGlvbjpjb2xvciAuMTVzOwp9Ci5nbG9zLWJ0bjpob3ZlciB7IGNvbG9yOnZhcigtLXRleHQpOyB9CgouZ2xvcy1ncmlkIHsKICBkaXNwbGF5Om5vbmU7IGdyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyOwogIGJhY2tncm91bmQ6dmFyKC0tc3VyZjIpOyBib3JkZXItdG9wOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwp9Ci5nbG9zLWdyaWQub3BlbiB7IGRpc3BsYXk6Z3JpZDsgfQoKLmdpIHsKICBwYWRkaW5nOjE0cHggMjJweDsgYm9yZGVyLWJvdHRvbToxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmlnaHQ6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Cn0KLmdpOm50aC1jaGlsZChldmVuKXtib3JkZXItcmlnaHQ6bm9uZTt9Ci5naS10ZXJtIHsKICBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC1zaXplOjEwcHg7IGZvbnQtd2VpZ2h0OjcwMDsKICBsZXR0ZXItc3BhY2luZzouMDhlbTsgdGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOyBjb2xvcjp2YXIoLS1tdXRlZDIpOyBtYXJnaW4tYm90dG9tOjNweDsKfQouZ2ktZGVmIHsgZm9udC1zaXplOjExcHg7IGNvbG9yOnZhcigtLW11dGVkKTsgbGluZS1oZWlnaHQ6MS41OyB9Cgpmb290ZXIgewogIHRleHQtYWxpZ246Y2VudGVyOyBwYWRkaW5nOjIycHg7IGZvbnQtc2l6ZToxMHB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7CiAgYm9yZGVyLXRvcDoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKfQpmb290ZXIgYSB7IGNvbG9yOnZhcigtLW11dGVkMik7IHRleHQtZGVjb3JhdGlvbjpub25lOyB9CmZvb3RlciBhOmhvdmVyIHsgY29sb3I6dmFyKC0tdGV4dCk7IH0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBBTklNQVRJT05TCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwpAa2V5ZnJhbWVzIGZhZGVJbiB7IGZyb217b3BhY2l0eTowO310b3tvcGFjaXR5OjE7fSB9CkBrZXlmcmFtZXMgZmFkZVVwIHsgZnJvbXtvcGFjaXR5OjA7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoMTBweCk7fXRve29wYWNpdHk6MTt0cmFuc2Zvcm06dHJhbnNsYXRlWSgwKTt9IH0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBSRVNQT05TSVZFCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwpAbWVkaWEobWF4LXdpZHRoOjkwMHB4KXsKICA6cm9vdHsgLS1kcmF3ZXItdzogMTAwdnc7IH0KICAuYm9keS13cmFwLmRyYXdlci1vcGVuIC5tYWluLWNvbnRlbnQgeyBtYXJnaW4tcmlnaHQ6MDsgfQogIC5kcmF3ZXIgeyB3aWR0aDoxMDB2dzsgfQp9CkBtZWRpYShtYXgtd2lkdGg6NzAwcHgpewogIC5oZXJvLWdyaWR7IGdyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyOyB9CiAgLmhjYXJkLmdhcHsgZ3JpZC1jb2x1bW46c3BhbiAyOyB9CiAgLm1ldHJpY3MtZ3JpZHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnI7IH0KICAuaGNhcmQtdmFseyBmb250LXNpemU6MjZweDsgfQogIHRoZWFkIHRoOm50aC1jaGlsZCg0KSwgdGJvZHkgdGQ6bnRoLWNoaWxkKDQpeyBkaXNwbGF5Om5vbmU7IH0KICAucy1yaWdodCB7IGRpc3BsYXk6bm9uZTsgfQogIHRkLmRpbSAudHMtZGF5IHsgZm9udC1zaXplOjhweDsgfQogIHRkLmRpbSAudHMtaG91ciB7IGZvbnQtc2l6ZToxMHB4OyB9Cn0KQG1lZGlhKG1heC13aWR0aDo0ODBweCl7CiAgLmhlcm8tZ3JpZHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcjsgfQogIC5oY2FyZC5nYXB7IGdyaWQtY29sdW1uOnNwYW4gMTsgfQogIGhlYWRlcnsgcGFkZGluZzowIDE0cHg7IH0KICAudGFnLW1lcmNhZG97IGRpc3BsYXk6bm9uZTsgfQogIC5idG4tdGFzYXMgc3Bhbi5sYWJlbC1sb25nIHsgZGlzcGxheTpub25lOyB9Cn0KCi8qIERSQVdFUiBPVkVSTEFZIChtb2JpbGUpICovCi5vdmVybGF5IHsKICBkaXNwbGF5Om5vbmU7CiAgcG9zaXRpb246Zml4ZWQ7IGluc2V0OjA7IHotaW5kZXg6MTQwOwogIGJhY2tncm91bmQ6cmdiYSgwLDAsMCwuNTUpOwogIGJhY2tkcm9wLWZpbHRlcjpibHVyKDJweCk7Cn0KQG1lZGlhKG1heC13aWR0aDo5MDBweCl7CiAgLm92ZXJsYXkuc2hvdyB7IGRpc3BsYXk6YmxvY2s7IH0KfQo8L3N0eWxlPgo8L2hlYWQ+Cjxib2R5Pgo8ZGl2IGNsYXNzPSJhcHAiPgoKPCEtLSDilIDilIAgSEVBREVSIOKUgOKUgCAtLT4KPGhlYWRlcj4KICA8ZGl2IGNsYXNzPSJsb2dvIj4KICAgIDxzcGFuIGNsYXNzPSJsaXZlLWRvdCI+PC9zcGFuPgogICAgUkFEQVIgTUVQL0NDTAogIDwvZGl2PgogIDxkaXYgY2xhc3M9ImhlYWRlci1yaWdodCI+CiAgICA8ZGl2IGNsYXNzPSJmcmVzaC1iYWRnZSIgaWQ9ImZyZXNoLWJhZGdlIj4KICAgICAgPHNwYW4gY2xhc3M9ImZyZXNoLWRvdCI+PC9zcGFuPgogICAgICA8c3BhbiBpZD0iZnJlc2gtYmFkZ2UtdGV4dCI+QWN0dWFsaXphbmRv4oCmPC9zcGFuPgogICAgPC9kaXY+CiAgICA8c3BhbiBjbGFzcz0idGFnLW1lcmNhZG8gY2xvc2VkIiBpZD0idGFnLW1lcmNhZG8iPk1lcmNhZG8gY2VycmFkbzwvc3Bhbj4KICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tdGFzYXMiIGlkPSJidG5UYXNhcyIgb25jbGljaz0idG9nZ2xlRHJhd2VyKCkiPgogICAgICDwn5OKIDxzcGFuIGNsYXNzPSJsYWJlbC1sb25nIj5UYXNhcyAmYW1wOyBCb25vczwvc3Bhbj4KICAgIDwvYnV0dG9uPgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1hbGVydCI+8J+UlCBBbGVydGFzPC9idXR0b24+CiAgPC9kaXY+CjwvaGVhZGVyPgoKPCEtLSDilIDilIAgT1ZFUkxBWSAobW9iaWxlKSDilIDilIAgLS0+CjxkaXYgY2xhc3M9Im92ZXJsYXkiIGlkPSJvdmVybGF5IiBvbmNsaWNrPSJ0b2dnbGVEcmF3ZXIoKSI+PC9kaXY+Cgo8IS0tIOKUgOKUgCBCT0RZIFdSQVAg4pSA4pSAIC0tPgo8ZGl2IGNsYXNzPSJib2R5LXdyYXAiIGlkPSJib2R5V3JhcCI+CgogIDwhLS0g4pWQ4pWQ4pWQ4pWQIE1BSU4g4pWQ4pWQ4pWQ4pWQIC0tPgogIDxkaXYgY2xhc3M9Im1haW4tY29udGVudCI+CgogICAgPCEtLSBTVEFUVVMgQkFOTkVSIC0tPgogICAgPGRpdiBjbGFzcz0ic3RhdHVzLWJhbm5lciBzaW1pbGFyIiBpZD0ic3RhdHVzLWJhbm5lciI+CiAgICAgIDxkaXYgY2xhc3M9InMtbGVmdCI+CiAgICAgICAgPGRpdiBjbGFzcz0icy10aXRsZSI+CiAgICAgICAgICA8c3BhbiBpZD0ic3RhdHVzLWxhYmVsIj5NRVAg4omIIENDTDwvc3Bhbj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJzLWJhZGdlIiBpZD0ic3RhdHVzLWJhZGdlIj5TaW1pbGFyPC9zcGFuPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InMtc3ViIj5MYSBicmVjaGEgZXN0w6EgZGVudHJvIGRlbCB1bWJyYWwg4oCUIGxvcyBwcmVjaW9zIHNvbiBjb21wYXJhYmxlczwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0icy1yaWdodCI+CiAgICAgICAgPGRpdj7Dmmx0aW1hIGNvcnJpZGE6IDxzdHJvbmcgaWQ9Imxhc3QtcnVuLXRpbWUiPuKAlDwvc3Ryb25nPjwvZGl2PgogICAgICAgIDxkaXYgaWQ9ImNvdW50ZG93bi10ZXh0Ij5QcsOzeGltYSBhY3R1YWxpemFjacOzbiBlbiA1OjAwPC9kaXY+CiAgICAgICAgPGRpdj5Dcm9uIEdNVC0zIMK3IEx1buKAk1ZpZSAxMDozMOKAkzE4OjAwPC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJlcnJvci1iYW5uZXIiIGlkPSJlcnJvci1iYW5uZXIiPgogICAgICA8c3BhbiBpZD0iZXJyb3ItYmFubmVyLXRleHQiPkVycm9yIGFsIGFjdHVhbGl6YXIgwrcgUmVpbnRlbnRhcjwvc3Bhbj4KICAgICAgPGJ1dHRvbiBpZD0iZXJyb3ItcmV0cnktYnRuIiB0eXBlPSJidXR0b24iPlJlaW50ZW50YXI8L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDwhLS0gSEVSTyBDQVJEUyAtLT4KICAgIDxkaXYgY2xhc3M9Imhlcm8tZ3JpZCI+CiAgICAgIDxkaXYgY2xhc3M9ImhjYXJkIG1lcCI+CiAgICAgICAgPGRpdiBjbGFzcz0iYmFyIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC1sYWJlbCI+CiAgICAgICAgICA8c3BhbiBjbGFzcz0iZG90Ij48L3NwYW4+CiAgICAgICAgICA8c3BhbiBjbGFzcz0idGlwIiBkYXRhLXQ9IkTDs2xhciBCb2xzYSDigJQgY29tcHJhL3ZlbnRhIGRlIGJvbm9zIGVuICRBUlMgeSBVU0QiPk1FUCB2ZW50YSDik5g8L3NwYW4+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtdmFsIiBpZD0ibWVwLXZhbCI+JDEuMjY0PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtc3ViIj5kb2xhcml0by5hciDCtyB2ZW50YTwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaGNhcmQgY2NsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJiYXIiPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLWxhYmVsIj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJkb3QiPjwvc3Bhbj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0aXAiIGRhdGEtdD0iQ29udGFkbyBjb24gTGlxdWlkYWNpw7NuIOKAlCBzaW1pbGFyIGFsIE1FUCBjb24gZ2lybyBhbCBleHRlcmlvciI+Q0NMIHZlbnRhIOKTmDwvc3Bhbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC12YWwiIGlkPSJjY2wtdmFsIj4kMS4yNzE8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC1zdWIiPmRvbGFyaXRvLmFyIMK3IHZlbnRhPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoY2FyZCBnYXAiPgogICAgICAgIDxkaXYgY2xhc3M9ImJhciI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtbGFiZWwiPgogICAgICAgICAgPHNwYW4gY2xhc3M9ImRvdCI+PC9zcGFuPgogICAgICAgICAgPHNwYW4gY2xhc3M9InRpcCIgZGF0YS10PSJCcmVjaGEgcmVsYXRpdmEgY29udHJhIGVsIHByb21lZGlvIGVudHJlIE1FUCB5IENDTCI+QnJlY2hhIOKTmDwvc3Bhbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC12YWwiIGlkPSJicmVjaGEtYWJzIj4kNzwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLXBjdCIgaWQ9ImJyZWNoYS1wY3QiPjAuNTUlPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtc3ViIj5kaWZlcmVuY2lhIGFic29sdXRhIMK3IHBvcmNlbnR1YWw8L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8IS0tIENIQVJUIC0tPgogICAgPGRpdiBjbGFzcz0iY2hhcnQtY2FyZCI+CiAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0LXRvcCI+CiAgICAgICAgPGRpdiBjbGFzcz0iY2hhcnQtdHRsIiBpZD0idHJlbmQtdGl0bGUiPlRlbmRlbmNpYSBNRVAvQ0NMIOKAlCAxIGTDrWE8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJwaWxscyI+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJwaWxsIG9uIiBkYXRhLWZpbHRlcj0iMWQiPjEgRMOtYTwvYnV0dG9uPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0icGlsbCIgZGF0YS1maWx0ZXI9IjF3Ij4xIFNlbWFuYTwvYnV0dG9uPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0icGlsbCIgZGF0YS1maWx0ZXI9IjFtIj4xIE1lczwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ibGVnZW5kcyI+CiAgICAgICAgPGRpdiBjbGFzcz0ibGVnIj48ZGl2IGNsYXNzPSJsZWctbGluZSIgc3R5bGU9ImJhY2tncm91bmQ6dmFyKC0tbWVwKSI+PC9kaXY+TUVQPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibGVnIj48ZGl2IGNsYXNzPSJsZWctbGluZSIgc3R5bGU9ImJhY2tncm91bmQ6dmFyKC0tY2NsKSI+PC9kaXY+Q0NMPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8c3ZnIGNsYXNzPSJjaGFydCIgaWQ9InRyZW5kLWNoYXJ0IiB2aWV3Qm94PSIwIDAgODYwIDE2MCIgcHJlc2VydmVBc3BlY3RSYXRpbz0ibm9uZSI+CiAgICAgICAgPGxpbmUgeDE9IjAiIHkxPSI0MCIgeDI9Ijg2MCIgeTI9IjQwIiBzdHJva2U9IiMxZTI1MzAiIHN0cm9rZS13aWR0aD0iMSIvPgogICAgICAgIDxsaW5lIHgxPSIwIiB5MT0iODAiIHgyPSI4NjAiIHkyPSI4MCIgc3Ryb2tlPSIjMWUyNTMwIiBzdHJva2Utd2lkdGg9IjEiLz4KICAgICAgICA8bGluZSB4MT0iMCIgeTE9IjEyMCIgeDI9Ijg2MCIgeTI9IjEyMCIgc3Ryb2tlPSIjMWUyNTMwIiBzdHJva2Utd2lkdGg9IjEiLz4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteS10b3AiIHg9IjIiIHk9IjM3IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjgiIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXktbWlkIiB4PSIyIiB5PSI3NyIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI4IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC15LWxvdyIgeD0iMiIgeT0iMTE3IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjgiIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgPHBvbHlsaW5lIGlkPSJ0cmVuZC1tZXAtbGluZSIgcG9pbnRzPSIiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzI5YjZmNiIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+CiAgICAgICAgPHBvbHlsaW5lIGlkPSJ0cmVuZC1jY2wtbGluZSIgcG9pbnRzPSIiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2IzOWRkYiIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+CiAgICAgICAgPGxpbmUgaWQ9InRyZW5kLWhvdmVyLWxpbmUiIHgxPSIwIiB5MT0iMTgiIHgyPSIwIiB5Mj0iMTMyIiBzdHJva2U9IiMyYTM0NDQiIHN0cm9rZS13aWR0aD0iMSIgb3BhY2l0eT0iMCIvPgogICAgICAgIDxjaXJjbGUgaWQ9InRyZW5kLWhvdmVyLW1lcCIgY3g9IjAiIGN5PSIwIiByPSIzLjUiIGZpbGw9IiMyOWI2ZjYiIG9wYWNpdHk9IjAiLz4KICAgICAgICA8Y2lyY2xlIGlkPSJ0cmVuZC1ob3Zlci1jY2wiIGN4PSIwIiBjeT0iMCIgcj0iMy41IiBmaWxsPSIjYjM5ZGRiIiBvcGFjaXR5PSIwIi8+CiAgICAgICAgPGcgaWQ9InRyZW5kLXRvb2x0aXAiIG9wYWNpdHk9IjAiPgogICAgICAgICAgPHJlY3QgaWQ9InRyZW5kLXRvb2x0aXAtYmciIHg9IjAiIHk9IjAiIHdpZHRoPSIxNDgiIGhlaWdodD0iNTYiIHJ4PSI2IiBmaWxsPSIjMTYxYjIyIiBzdHJva2U9IiMyYTM0NDQiLz4KICAgICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC10aXAtdGltZSIgeD0iMTAiIHk9IjE0IiBmaWxsPSIjNTU2MDcwIiBmb250LXNpemU9IjgiIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgICA8dGV4dCBpZD0idHJlbmQtdGlwLW1lcCIgeD0iMTAiIHk9IjI4IiBmaWxsPSIjMjliNmY2IiBmb250LXNpemU9IjkiIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj5NRVAg4oCUPC90ZXh0PgogICAgICAgICAgPHRleHQgaWQ9InRyZW5kLXRpcC1jY2wiIHg9IjEwIiB5PSI0MCIgZmlsbD0iI2IzOWRkYiIgZm9udC1zaXplPSI5IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+Q0NMIOKAlDwvdGV4dD4KICAgICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC10aXAtZ2FwIiB4PSIxMCIgeT0iNTIiIGZpbGw9IiNmZmNjMDAiIGZvbnQtc2l6ZT0iOCIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPkJyZWNoYSDigJQ8L3RleHQ+CiAgICAgICAgPC9nPgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC14LTEiIHg9IjI4IiB5PSIxNTQiIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iNyIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteC0yIiB4PSIyMTgiIHk9IjE1NCIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI3IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC14LTMiIHg9IjQxOCIgeT0iMTU0IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjciIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXgtNCIgeD0iNjA4IiB5PSIxNTQiIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iNyIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteC01IiB4PSI3OTgiIHk9IjE1NCIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI3IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICA8L3N2Zz4KICAgIDwvZGl2PgoKICAgIDwhLS0gTUVUUklDUyAtLT4KICAgIDxkaXYgY2xhc3M9Im1ldHJpY3MtZ3JpZCI+CiAgICAgIDxkaXYgY2xhc3M9Im1jYXJkIj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1sYWJlbCIgaWQ9Im1ldHJpYy1jb3VudC1sYWJlbCI+TXVlc3RyYXMgMSBkw61hPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtdmFsIiBpZD0ibWV0cmljLWNvdW50LTI0aCI+4oCUPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtc3ViIiBpZD0ibWV0cmljLWNvdW50LXN1YiI+cmVnaXN0cm9zIGRlbCBwZXLDrW9kbyBmaWx0cmFkbzwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ibWNhcmQiPgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLWxhYmVsIiBpZD0ibWV0cmljLXNpbWlsYXItbGFiZWwiPlZlY2VzIHNpbWlsYXI8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC12YWwiIHN0eWxlPSJjb2xvcjp2YXIoLS1ncmVlbikiIGlkPSJtZXRyaWMtc2ltaWxhci0yNGgiPuKAlDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXN1YiIgaWQ9Im1ldHJpYy1zaW1pbGFyLXN1YiI+bW9tZW50b3MgZW4gem9uYSDiiaQxJSBvIOKJpCQxMDwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ibWNhcmQiPgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLWxhYmVsIiBpZD0ibWV0cmljLW1pbi1sYWJlbCI+QnJlY2hhIG3DrW4uPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtdmFsIiBpZD0ibWV0cmljLW1pbi0yNGgiPuKAlDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXN1YiIgaWQ9Im1ldHJpYy1taW4tc3ViIj5tw61uaW1hIGRlbCBwZXLDrW9kbyBmaWx0cmFkbzwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ibWNhcmQiPgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLWxhYmVsIiBpZD0ibWV0cmljLW1heC1sYWJlbCI+QnJlY2hhIG3DoXguPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtdmFsIiBzdHlsZT0iY29sb3I6dmFyKC0teWVsbG93KSIgaWQ9Im1ldHJpYy1tYXgtMjRoIj7igJQ8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1zdWIiIGlkPSJtZXRyaWMtbWF4LXN1YiI+bcOheGltYSBkZWwgcGVyw61vZG8gZmlsdHJhZG88L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8IS0tIFRBQkxFIC0tPgogICAgPGRpdiBjbGFzcz0idGFibGUtY2FyZCI+CiAgICAgIDxkaXYgY2xhc3M9InRhYmxlLXRvcCI+CiAgICAgICAgPGRpdiBjbGFzcz0idGFibGUtdHRsIj5IaXN0b3JpYWwgZGUgcmVnaXN0cm9zPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0idGFibGUtY2FwIiBpZD0iaGlzdG9yeS1jYXAiPsOabHRpbWFzIOKAlCBtdWVzdHJhczwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaGlzdG9yeS10YWJsZS13cmFwIj4KICAgICAgPHRhYmxlIGlkPSJoaXN0b3J5LXRhYmxlIj4KICAgICAgICA8Y29sZ3JvdXAgaWQ9Imhpc3RvcnktY29sZ3JvdXAiPgogICAgICAgICAgPGNvbCBkYXRhLWNvbC1pbmRleD0iMCI+CiAgICAgICAgICA8Y29sIGRhdGEtY29sLWluZGV4PSIxIj4KICAgICAgICAgIDxjb2wgZGF0YS1jb2wtaW5kZXg9IjIiPgogICAgICAgICAgPGNvbCBkYXRhLWNvbC1pbmRleD0iMyI+CiAgICAgICAgICA8Y29sIGRhdGEtY29sLWluZGV4PSI0Ij4KICAgICAgICAgIDxjb2wgZGF0YS1jb2wtaW5kZXg9IjUiPgogICAgICAgIDwvY29sZ3JvdXA+CiAgICAgICAgPHRoZWFkPgogICAgICAgICAgPHRyPgogICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImNvbC1sYWJlbCI+RMOtYSAvIEhvcmE8L3NwYW4+PHNwYW4gY2xhc3M9ImNvbC1yZXNpemVyIiBkYXRhLWNvbC1pbmRleD0iMCIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIETDrWEgLyBIb3JhIj48L3NwYW4+PC90aD4KICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJjb2wtbGFiZWwiPk1FUDwvc3Bhbj48c3BhbiBjbGFzcz0iY29sLXJlc2l6ZXIiIGRhdGEtY29sLWluZGV4PSIxIiByb2xlPSJzZXBhcmF0b3IiIGFyaWEtbGFiZWw9IkFqdXN0YXIgYW5jaG8gZGUgTUVQIj48L3NwYW4+PC90aD4KICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJjb2wtbGFiZWwiPkNDTDwvc3Bhbj48c3BhbiBjbGFzcz0iY29sLXJlc2l6ZXIiIGRhdGEtY29sLWluZGV4PSIyIiByb2xlPSJzZXBhcmF0b3IiIGFyaWEtbGFiZWw9IkFqdXN0YXIgYW5jaG8gZGUgQ0NMIj48L3NwYW4+PC90aD4KICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJjb2wtbGFiZWwiPkRpZiAkPC9zcGFuPjxzcGFuIGNsYXNzPSJjb2wtcmVzaXplciIgZGF0YS1jb2wtaW5kZXg9IjMiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBEaWYgJCI+PC9zcGFuPjwvdGg+CiAgICAgICAgICAgIDx0aD48c3BhbiBjbGFzcz0iY29sLWxhYmVsIj5EaWYgJTwvc3Bhbj48c3BhbiBjbGFzcz0iY29sLXJlc2l6ZXIiIGRhdGEtY29sLWluZGV4PSI0IiByb2xlPSJzZXBhcmF0b3IiIGFyaWEtbGFiZWw9IkFqdXN0YXIgYW5jaG8gZGUgRGlmICUiPjwvc3Bhbj48L3RoPgogICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImNvbC1sYWJlbCI+RXN0YWRvPC9zcGFuPjxzcGFuIGNsYXNzPSJjb2wtcmVzaXplciIgZGF0YS1jb2wtaW5kZXg9IjUiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBFc3RhZG8iPjwvc3Bhbj48L3RoPgogICAgICAgICAgPC90cj4KICAgICAgICA8L3RoZWFkPgogICAgICAgIDx0Ym9keSBpZD0iaGlzdG9yeS1yb3dzIj48L3Rib2R5PgogICAgICA8L3RhYmxlPgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAgIDwhLS0gR0xPU0FSSU8gLS0+CiAgICA8ZGl2IGNsYXNzPSJnbG9zYXJpbyI+CiAgICAgIDxidXR0b24gY2xhc3M9Imdsb3MtYnRuIiBvbmNsaWNrPSJ0b2dnbGVHbG9zKHRoaXMpIj4KICAgICAgICA8c3Bhbj7wn5OWIEdsb3NhcmlvIGRlIHTDqXJtaW5vczwvc3Bhbj4KICAgICAgICA8c3BhbiBpZD0iZ2xvc0Fycm93Ij7ilr48L3NwYW4+CiAgICAgIDwvYnV0dG9uPgogICAgICA8ZGl2IGNsYXNzPSJnbG9zLWdyaWQiIGlkPSJnbG9zR3JpZCI+CiAgICAgICAgPGRpdiBjbGFzcz0iZ2kiPjxkaXYgY2xhc3M9ImdpLXRlcm0iPk1FUCB2ZW50YTwvZGl2PjxkaXYgY2xhc3M9ImdpLWRlZiI+UHJlY2lvIGRlIHZlbnRhIGRlbCBkw7NsYXIgTUVQIChNZXJjYWRvIEVsZWN0csOzbmljbyBkZSBQYWdvcykgdsOtYSBjb21wcmEvdmVudGEgZGUgYm9ub3MgZW4gJEFSUyB5IFVTRC48L2Rpdj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJnaSI+PGRpdiBjbGFzcz0iZ2ktdGVybSI+Q0NMIHZlbnRhPC9kaXY+PGRpdiBjbGFzcz0iZ2ktZGVmIj5Db250YWRvIGNvbiBMaXF1aWRhY2nDs24g4oCUIHNpbWlsYXIgYWwgTUVQIHBlcm8gcGVybWl0ZSB0cmFuc2ZlcmlyIGZvbmRvcyBhbCBleHRlcmlvci4gU3VlbGUgY290aXphciBsZXZlbWVudGUgcG9yIGVuY2ltYS48L2Rpdj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJnaSI+PGRpdiBjbGFzcz0iZ2ktdGVybSI+RGlmZXJlbmNpYSAlPC9kaXY+PGRpdiBjbGFzcz0iZ2ktZGVmIj5CcmVjaGEgcmVsYXRpdmEgY2FsY3VsYWRhIGNvbnRyYSBlbCBwcm9tZWRpbyBlbnRyZSBNRVAgeSBDQ0wuIFVtYnJhbCBTSU1JTEFSOiDiiaQgMSUgbyDiiaQgJDEwIEFSUy48L2Rpdj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJnaSI+PGRpdiBjbGFzcz0iZ2ktdGVybSI+RnJlc2N1cmEgZGVsIGRhdG88L2Rpdj48ZGl2IGNsYXNzPSJnaS1kZWYiPlRpZW1wbyBkZXNkZSBlbCDDumx0aW1vIHRpbWVzdGFtcCBkZSBkb2xhcml0by5hci4gRWwgY3JvbiBjb3JyZSBjYWRhIDUgbWluIGVuIGTDrWFzIGjDoWJpbGVzLjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImdpIj48ZGl2IGNsYXNzPSJnaS10ZXJtIj5Fc3RhZG8gU0lNSUxBUjwvZGl2PjxkaXYgY2xhc3M9ImdpLWRlZiI+Q3VhbmRvIE1FUCB5IENDTCBlc3TDoW4gZGVudHJvIGRlbCB1bWJyYWwg4oCUIG1vbWVudG8gaWRlYWwgcGFyYSBvcGVyYXIgYnVzY2FuZG8gcGFyaWRhZCBlbnRyZSBhbWJvcyB0aXBvcy48L2Rpdj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJnaSI+PGRpdiBjbGFzcz0iZ2ktdGVybSI+TWVyY2FkbyBBUkc8L2Rpdj48ZGl2IGNsYXNzPSJnaS1kZWYiPlZlbnRhbmEgb3BlcmF0aXZhOiBsdW5lcyBhIHZpZXJuZXMgZGUgMTA6MzAgYSAxNzo1OSAoR01ULTMsIEJ1ZW5vcyBBaXJlcykuPC9kaXY+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgPGZvb3Rlcj4KICAgICAgRnVlbnRlOiA8YSBocmVmPSIjIj5kb2xhcml0by5hcjwvYT4gwrcgPGEgaHJlZj0iIyI+YnltYS5jb20uYXI8L2E+IMK3IERhdG9zIGNhZGEgNSBtaW4gZW4gZMOtYXMgaMOhYmlsZXMgwrcgPGEgaHJlZj0iIyI+UmVwb3J0YXIgcHJvYmxlbWE8L2E+CiAgICA8L2Zvb3Rlcj4KCiAgPC9kaXY+PCEtLSAvbWFpbi1jb250ZW50IC0tPgoKICA8IS0tIOKVkOKVkOKVkOKVkCBEUkFXRVIg4pWQ4pWQ4pWQ4pWQIC0tPgogIDxkaXYgY2xhc3M9ImRyYXdlciIgaWQ9ImRyYXdlciI+CgogICAgPGRpdiBjbGFzcz0iZHJhd2VyLWhlYWRlciI+CiAgICAgIDxkaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZHJhd2VyLXRpdGxlIj7wn5OKIFRhc2FzICZhbXA7IEJvbm9zPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZHJhd2VyLXNvdXJjZSI+RnVlbnRlczogZG9sYXJpdG8uYXIgwrcgYnltYS5jb20uYXI8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0bi1jbG9zZSIgb25jbGljaz0idG9nZ2xlRHJhd2VyKCkiPuKclTwvYnV0dG9uPgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iZHJhd2VyLWJvZHkiPgogICAgICA8ZGl2IGNsYXNzPSJjb250ZXh0LWJveCI+CiAgICAgICAgPHN0cm9uZz5QcsOzeGltYW1lbnRlPC9zdHJvbmc+PGJyPgogICAgICAgIEVzdGEgc2VjY2nDs24gZGUgVGFzYXMgeSBCb25vcyBzZSBlbmN1ZW50cmEgZW4gcmV2aXNpw7NuIHkgdm9sdmVyw6EgZW4gdW5hIHByw7N4aW1hIHZlcnNpw7NuLgogICAgICA8L2Rpdj4KCiAgICA8L2Rpdj48IS0tIC9kcmF3ZXItYm9keSAtLT4KICA8L2Rpdj48IS0tIC9kcmF3ZXIgLS0+Cgo8L2Rpdj48IS0tIC9ib2R5LXdyYXAgLS0+CjwvZGl2PjwhLS0gL2FwcCAtLT4KCjxzY3JpcHQ+CiAgLy8gMSkgQ29uc3RhbnRlcyB5IGNvbmZpZ3VyYWNpw7NuCiAgY29uc3QgRU5EUE9JTlRTID0gewogICAgbWVwQ2NsOiAnL2FwaS9kYXRhJwogIH07CiAgY29uc3QgQVJHX1RaID0gJ0FtZXJpY2EvQXJnZW50aW5hL0J1ZW5vc19BaXJlcyc7CiAgY29uc3QgRkVUQ0hfSU5URVJWQUxfTVMgPSAzMDAwMDA7CiAgY29uc3QgQ0FDSEVfS0VZID0gJ3JhZGFyX2NhY2hlJzsKICBjb25zdCBISVNUT1JZX0NPTFNfS0VZID0gJ3JhZGFyX2hpc3RvcnlfY29sX3dpZHRoc192MSc7CiAgY29uc3QgQ0FDSEVfVFRMX01TID0gMTUgKiA2MCAqIDEwMDA7CiAgY29uc3QgUkVUUllfREVMQVlTID0gWzEwMDAwLCAzMDAwMCwgNjAwMDBdOwogIGNvbnN0IFNJTUlMQVJfUENUX1RIUkVTSE9MRCA9IDE7CiAgY29uc3QgU0lNSUxBUl9BUlNfVEhSRVNIT0xEID0gMTA7CiAgY29uc3QgVFJFTkRfTUFYX1BPSU5UUyA9IDI0MDsKICBjb25zdCBISVNUT1JZX0RFRkFVTFRfQ09MX1dJRFRIUyA9IFsxNzAsIDE2MCwgMTYwLCAxMjAsIDEyMCwgMTcwXTsKICBjb25zdCBISVNUT1JZX01JTl9DT0xfV0lEVEhTID0gWzEyMCwgMTEwLCAxMTAsIDkwLCA5MCwgMTIwXTsKICBjb25zdCBOVU1FUklDX0lEUyA9IFsKICAgICdtZXAtdmFsJywgJ2NjbC12YWwnLCAnYnJlY2hhLWFicycsICdicmVjaGEtcGN0JwogIF07CiAgY29uc3Qgc3RhdGUgPSB7CiAgICByZXRyeUluZGV4OiAwLAogICAgcmV0cnlUaW1lcjogbnVsbCwKICAgIGxhc3RTdWNjZXNzQXQ6IDAsCiAgICBpc0ZldGNoaW5nOiBmYWxzZSwKICAgIGZpbHRlck1vZGU6ICcxZCcsCiAgICBsYXN0TWVwUGF5bG9hZDogbnVsbCwKICAgIHRyZW5kUm93czogW10sCiAgICB0cmVuZEhvdmVyQm91bmQ6IGZhbHNlLAogICAgaGlzdG9yeVJlc2l6ZUJvdW5kOiBmYWxzZSwKICAgIGhpc3RvcnlDb2xXaWR0aHM6IFtdLAogICAgc291cmNlVHNNczogbnVsbCwKICAgIGZyZXNoQmFkZ2VNb2RlOiAnaWRsZScsCiAgICBmcmVzaFRpY2tlcjogbnVsbCwKICAgIGxhdGVzdDogewogICAgICBtZXA6IG51bGwsCiAgICAgIGNjbDogbnVsbCwKICAgICAgYnJlY2hhQWJzOiBudWxsLAogICAgICBicmVjaGFQY3Q6IG51bGwKICAgIH0KICB9OwoKICAvLyAyKSBIZWxwZXJzCiAgY29uc3QgZm10QXJnVGltZSA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlcy1BUicsIHsKICAgIHRpbWVab25lOiBBUkdfVFosCiAgICBob3VyOiAnMi1kaWdpdCcsCiAgICBtaW51dGU6ICcyLWRpZ2l0JwogIH0pOwogIGNvbnN0IGZtdEFyZ1RpbWVTZWMgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZXMtQVInLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgaG91cjogJzItZGlnaXQnLAogICAgbWludXRlOiAnMi1kaWdpdCcsCiAgICBzZWNvbmQ6ICcyLWRpZ2l0JwogIH0pOwogIGNvbnN0IGZtdEFyZ0hvdXIgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZXMtQVInLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgaG91cjogJzItZGlnaXQnLAogICAgbWludXRlOiAnMi1kaWdpdCcsCiAgICBob3VyMTI6IGZhbHNlCiAgfSk7CiAgY29uc3QgZm10QXJnRGF5TW9udGggPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZXMtQVInLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgZGF5OiAnMi1kaWdpdCcsCiAgICBtb250aDogJzItZGlnaXQnCiAgfSk7CiAgY29uc3QgZm10QXJnRGF0ZSA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlbi1DQScsIHsKICAgIHRpbWVab25lOiBBUkdfVFosCiAgICB5ZWFyOiAnbnVtZXJpYycsCiAgICBtb250aDogJzItZGlnaXQnLAogICAgZGF5OiAnMi1kaWdpdCcKICB9KTsKICBjb25zdCBmbXRBcmdXZWVrZGF5ID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VuLVVTJywgewogICAgdGltZVpvbmU6IEFSR19UWiwKICAgIHdlZWtkYXk6ICdzaG9ydCcKICB9KTsKICBjb25zdCBmbXRBcmdQYXJ0cyA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlbi1VUycsIHsKICAgIHRpbWVab25lOiBBUkdfVFosCiAgICB3ZWVrZGF5OiAnc2hvcnQnLAogICAgaG91cjogJzItZGlnaXQnLAogICAgbWludXRlOiAnMi1kaWdpdCcsCiAgICBzZWNvbmQ6ICcyLWRpZ2l0JywKICAgIGhvdXIxMjogZmFsc2UKICB9KTsKICBjb25zdCBXRUVLREFZID0geyBNb246IDEsIFR1ZTogMiwgV2VkOiAzLCBUaHU6IDQsIEZyaTogNSwgU2F0OiA2LCBTdW46IDcgfTsKCiAgZnVuY3Rpb24gdG9OdW1iZXIodmFsdWUpIHsKICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkpIHJldHVybiB2YWx1ZTsKICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKSB7CiAgICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSB2YWx1ZS5yZXBsYWNlKC9ccy9nLCAnJykucmVwbGFjZSgnLCcsICcuJykucmVwbGFjZSgvW15cZC4tXS9nLCAnJyk7CiAgICAgIGNvbnN0IHBhcnNlZCA9IE51bWJlcihub3JtYWxpemVkKTsKICAgICAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShwYXJzZWQpID8gcGFyc2VkIDogbnVsbDsKICAgIH0KICAgIHJldHVybiBudWxsOwogIH0KICBmdW5jdGlvbiBnZXRQYXRoKG9iaiwgcGF0aCkgewogICAgcmV0dXJuIHBhdGgucmVkdWNlKChhY2MsIGtleSkgPT4gKGFjYyAmJiBhY2Nba2V5XSAhPT0gdW5kZWZpbmVkID8gYWNjW2tleV0gOiB1bmRlZmluZWQpLCBvYmopOwogIH0KICBmdW5jdGlvbiBwaWNrTnVtYmVyKG9iaiwgcGF0aHMpIHsKICAgIGZvciAoY29uc3QgcGF0aCBvZiBwYXRocykgewogICAgICBjb25zdCB2ID0gZ2V0UGF0aChvYmosIHBhdGgpOwogICAgICBjb25zdCBuID0gdG9OdW1iZXIodik7CiAgICAgIGlmIChuICE9PSBudWxsKSByZXR1cm4gbjsKICAgIH0KICAgIHJldHVybiBudWxsOwogIH0KICBmdW5jdGlvbiBwaWNrQnlLZXlIaW50KG9iaiwgaGludCkgewogICAgaWYgKCFvYmogfHwgdHlwZW9mIG9iaiAhPT0gJ29iamVjdCcpIHJldHVybiBudWxsOwogICAgY29uc3QgbG93ZXIgPSBoaW50LnRvTG93ZXJDYXNlKCk7CiAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyhvYmopKSB7CiAgICAgIGlmIChrLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMobG93ZXIpKSB7CiAgICAgICAgY29uc3QgbiA9IHRvTnVtYmVyKHYpOwogICAgICAgIGlmIChuICE9PSBudWxsKSByZXR1cm4gbjsKICAgICAgICBpZiAodiAmJiB0eXBlb2YgdiA9PT0gJ29iamVjdCcpIHsKICAgICAgICAgIGNvbnN0IGRlZXAgPSBwaWNrQnlLZXlIaW50KHYsIGhpbnQpOwogICAgICAgICAgaWYgKGRlZXAgIT09IG51bGwpIHJldHVybiBkZWVwOwogICAgICAgIH0KICAgICAgfQogICAgICBpZiAodiAmJiB0eXBlb2YgdiA9PT0gJ29iamVjdCcpIHsKICAgICAgICBjb25zdCBkZWVwID0gcGlja0J5S2V5SGludCh2LCBoaW50KTsKICAgICAgICBpZiAoZGVlcCAhPT0gbnVsbCkgcmV0dXJuIGRlZXA7CiAgICAgIH0KICAgIH0KICAgIHJldHVybiBudWxsOwogIH0KICBmdW5jdGlvbiBnZXRBcmdOb3dQYXJ0cyhkYXRlID0gbmV3IERhdGUoKSkgewogICAgY29uc3QgcGFydHMgPSBmbXRBcmdQYXJ0cy5mb3JtYXRUb1BhcnRzKGRhdGUpLnJlZHVjZSgoYWNjLCBwKSA9PiB7CiAgICAgIGFjY1twLnR5cGVdID0gcC52YWx1ZTsKICAgICAgcmV0dXJuIGFjYzsKICAgIH0sIHt9KTsKICAgIHJldHVybiB7CiAgICAgIHdlZWtkYXk6IFdFRUtEQVlbcGFydHMud2Vla2RheV0gfHwgMCwKICAgICAgaG91cjogTnVtYmVyKHBhcnRzLmhvdXIgfHwgJzAnKSwKICAgICAgbWludXRlOiBOdW1iZXIocGFydHMubWludXRlIHx8ICcwJyksCiAgICAgIHNlY29uZDogTnVtYmVyKHBhcnRzLnNlY29uZCB8fCAnMCcpCiAgICB9OwogIH0KICBmdW5jdGlvbiBicmVjaGFQZXJjZW50KG1lcCwgY2NsKSB7CiAgICBpZiAobWVwID09PSBudWxsIHx8IGNjbCA9PT0gbnVsbCkgcmV0dXJuIG51bGw7CiAgICBjb25zdCBhdmcgPSAobWVwICsgY2NsKSAvIDI7CiAgICBpZiAoIWF2ZykgcmV0dXJuIG51bGw7CiAgICByZXR1cm4gKE1hdGguYWJzKG1lcCAtIGNjbCkgLyBhdmcpICogMTAwOwogIH0KICBmdW5jdGlvbiBmb3JtYXRNb25leSh2YWx1ZSwgZGlnaXRzID0gMCkgewogICAgaWYgKHZhbHVlID09PSBudWxsKSByZXR1cm4gJ+KAlCc7CiAgICByZXR1cm4gJyQnICsgdmFsdWUudG9Mb2NhbGVTdHJpbmcoJ2VzLUFSJywgewogICAgICBtaW5pbXVtRnJhY3Rpb25EaWdpdHM6IGRpZ2l0cywKICAgICAgbWF4aW11bUZyYWN0aW9uRGlnaXRzOiBkaWdpdHMKICAgIH0pOwogIH0KICBmdW5jdGlvbiBmb3JtYXRQZXJjZW50KHZhbHVlLCBkaWdpdHMgPSAyKSB7CiAgICBpZiAodmFsdWUgPT09IG51bGwpIHJldHVybiAn4oCUJzsKICAgIHJldHVybiB2YWx1ZS50b0ZpeGVkKGRpZ2l0cykgKyAnJSc7CiAgfQogIGZ1bmN0aW9uIHNldFRleHQoaWQsIHRleHQsIG9wdGlvbnMgPSB7fSkgewogICAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7CiAgICBpZiAoIWVsKSByZXR1cm47CiAgICBjb25zdCBuZXh0ID0gU3RyaW5nKHRleHQpOwogICAgY29uc3QgcHJldiA9IGVsLnRleHRDb250ZW50OwogICAgZWwudGV4dENvbnRlbnQgPSBuZXh0OwogICAgZWwuY2xhc3NMaXN0LnJlbW92ZSgnc2tlbGV0b24nKTsKICAgIGlmIChvcHRpb25zLmNoYW5nZUNsYXNzICYmIHByZXYgIT09IG5leHQpIHsKICAgICAgZWwuY2xhc3NMaXN0LmFkZCgndmFsdWUtY2hhbmdlZCcpOwogICAgICBzZXRUaW1lb3V0KCgpID0+IGVsLmNsYXNzTGlzdC5yZW1vdmUoJ3ZhbHVlLWNoYW5nZWQnKSwgNjAwKTsKICAgIH0KICB9CiAgZnVuY3Rpb24gc2V0RGFzaChpZHMpIHsKICAgIGlkcy5mb3JFYWNoKChpZCkgPT4gc2V0VGV4dChpZCwgJ+KAlCcpKTsKICB9CiAgZnVuY3Rpb24gc2V0TG9hZGluZyhpZHMsIGlzTG9hZGluZykgewogICAgaWRzLmZvckVhY2goKGlkKSA9PiB7CiAgICAgIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpOwogICAgICBpZiAoIWVsKSByZXR1cm47CiAgICAgIGVsLmNsYXNzTGlzdC50b2dnbGUoJ3NrZWxldG9uJywgaXNMb2FkaW5nKTsKICAgIH0pOwogIH0KICBmdW5jdGlvbiBzZXRGcmVzaEJhZGdlKHRleHQsIG1vZGUpIHsKICAgIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZyZXNoLWJhZGdlJyk7CiAgICBjb25zdCBsYWJlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmcmVzaC1iYWRnZS10ZXh0Jyk7CiAgICBpZiAoIWJhZGdlIHx8ICFsYWJlbCkgcmV0dXJuOwogICAgbGFiZWwudGV4dENvbnRlbnQgPSB0ZXh0OwogICAgc3RhdGUuZnJlc2hCYWRnZU1vZGUgPSBtb2RlIHx8ICdpZGxlJzsKICAgIGJhZGdlLmNsYXNzTGlzdC50b2dnbGUoJ2ZldGNoaW5nJywgbW9kZSA9PT0gJ2ZldGNoaW5nJyk7CiAgICBiYWRnZS5jbGFzc0xpc3QudG9nZ2xlKCdlcnJvcicsIG1vZGUgPT09ICdlcnJvcicpOwogICAgYmFkZ2Uub25jbGljayA9IG1vZGUgPT09ICdlcnJvcicgPyAoKSA9PiBmZXRjaEFsbCh7IG1hbnVhbDogdHJ1ZSB9KSA6IG51bGw7CiAgfQogIGZ1bmN0aW9uIGZvcm1hdFNvdXJjZUFnZUxhYmVsKHRzTXMpIHsKICAgIGxldCBuID0gdG9OdW1iZXIodHNNcyk7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShuKSkgcmV0dXJuIG51bGw7CiAgICBpZiAobiA8IDFlMTIpIG4gKj0gMTAwMDsKICAgIGNvbnN0IGFnZU1pbiA9IE1hdGgubWF4KDAsIE1hdGguZmxvb3IoKERhdGUubm93KCkgLSBuKSAvIDYwMDAwKSk7CiAgICBpZiAoYWdlTWluIDwgNjApIHJldHVybiBgJHthZ2VNaW59IG1pbmA7CiAgICBjb25zdCBoID0gTWF0aC5mbG9vcihhZ2VNaW4gLyA2MCk7CiAgICBjb25zdCBtID0gYWdlTWluICUgNjA7CiAgICByZXR1cm4gbSA9PT0gMCA/IGAke2h9IGhgIDogYCR7aH0gaCAke219IG1pbmA7CiAgfQogIGZ1bmN0aW9uIHJlZnJlc2hGcmVzaEJhZGdlRnJvbVNvdXJjZSgpIHsKICAgIGlmIChzdGF0ZS5mcmVzaEJhZGdlTW9kZSA9PT0gJ2ZldGNoaW5nJyB8fCBzdGF0ZS5mcmVzaEJhZGdlTW9kZSA9PT0gJ2Vycm9yJykgcmV0dXJuOwogICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoc3RhdGUuc291cmNlVHNNcykpIHJldHVybjsKICAgIGNvbnN0IGFnZUxhYmVsID0gZm9ybWF0U291cmNlQWdlTGFiZWwoc3RhdGUuc291cmNlVHNNcyk7CiAgICBpZiAoIWFnZUxhYmVsKSByZXR1cm47CiAgICBzZXRGcmVzaEJhZGdlKGDDmmx0aW1hIGFjdHVhbGl6YWNpw7NuIGhhY2U6ICR7YWdlTGFiZWx9YCwgJ2lkbGUnKTsKICB9CiAgZnVuY3Rpb24gc3RhcnRGcmVzaFRpY2tlcigpIHsKICAgIGlmIChzdGF0ZS5mcmVzaFRpY2tlcikgcmV0dXJuOwogICAgc3RhdGUuZnJlc2hUaWNrZXIgPSBzZXRJbnRlcnZhbChyZWZyZXNoRnJlc2hCYWRnZUZyb21Tb3VyY2UsIDMwMDAwKTsKICB9CiAgZnVuY3Rpb24gc2V0TWFya2V0VGFnKGlzT3BlbikgewogICAgY29uc3QgdGFnID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RhZy1tZXJjYWRvJyk7CiAgICBpZiAoIXRhZykgcmV0dXJuOwogICAgdGFnLnRleHRDb250ZW50ID0gaXNPcGVuID8gJ01lcmNhZG8gYWJpZXJ0bycgOiAnTWVyY2FkbyBjZXJyYWRvJzsKICAgIHRhZy5jbGFzc0xpc3QudG9nZ2xlKCdjbG9zZWQnLCAhaXNPcGVuKTsKICB9CiAgZnVuY3Rpb24gc2V0RXJyb3JCYW5uZXIoc2hvdywgdGV4dCkgewogICAgY29uc3QgYmFubmVyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Vycm9yLWJhbm5lcicpOwogICAgY29uc3QgbGFiZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZXJyb3ItYmFubmVyLXRleHQnKTsKICAgIGlmICghYmFubmVyKSByZXR1cm47CiAgICBpZiAodGV4dCAmJiBsYWJlbCkgbGFiZWwudGV4dENvbnRlbnQgPSB0ZXh0OwogICAgYmFubmVyLmNsYXNzTGlzdC50b2dnbGUoJ3Nob3cnLCAhIXNob3cpOwogIH0KICBmdW5jdGlvbiBleHRyYWN0Um9vdChqc29uKSB7CiAgICByZXR1cm4ganNvbiAmJiB0eXBlb2YganNvbiA9PT0gJ29iamVjdCcgPyAoanNvbi5kYXRhIHx8IGpzb24ucmVzdWx0IHx8IGpzb24pIDoge307CiAgfQogIGZ1bmN0aW9uIGdldEhpc3RvcnlDb2xFbGVtZW50cygpIHsKICAgIGNvbnN0IGNvbGdyb3VwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hpc3RvcnktY29sZ3JvdXAnKTsKICAgIHJldHVybiBjb2xncm91cCA/IEFycmF5LmZyb20oY29sZ3JvdXAucXVlcnlTZWxlY3RvckFsbCgnY29sJykpIDogW107CiAgfQogIGZ1bmN0aW9uIGNsYW1wSGlzdG9yeVdpZHRocyh3aWR0aHMpIHsKICAgIHJldHVybiBISVNUT1JZX0RFRkFVTFRfQ09MX1dJRFRIUy5tYXAoKGZhbGxiYWNrLCBpKSA9PiB7CiAgICAgIGNvbnN0IHJhdyA9IE51bWJlcih3aWR0aHM/LltpXSk7CiAgICAgIGlmICghTnVtYmVyLmlzRmluaXRlKHJhdykpIHJldHVybiBmYWxsYmFjazsKICAgICAgY29uc3QgbWluID0gSElTVE9SWV9NSU5fQ09MX1dJRFRIU1tpXSA/PyA4MDsKICAgICAgcmV0dXJuIE1hdGgubWF4KG1pbiwgTWF0aC5yb3VuZChyYXcpKTsKICAgIH0pOwogIH0KICBmdW5jdGlvbiBzYXZlSGlzdG9yeUNvbHVtbldpZHRocyh3aWR0aHMpIHsKICAgIHRyeSB7CiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKEhJU1RPUllfQ09MU19LRVksIEpTT04uc3RyaW5naWZ5KGNsYW1wSGlzdG9yeVdpZHRocyh3aWR0aHMpKSk7CiAgICB9IGNhdGNoIChlKSB7CiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tSYWRhck1FUF0gbm8gc2UgcHVkbyBndWFyZGFyIGFuY2hvcyBkZSBjb2x1bW5hcycsIGUpOwogICAgfQogIH0KICBmdW5jdGlvbiBsb2FkSGlzdG9yeUNvbHVtbldpZHRocygpIHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHJhdyA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKEhJU1RPUllfQ09MU19LRVkpOwogICAgICBpZiAoIXJhdykgcmV0dXJuIG51bGw7CiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KTsKICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHBhcnNlZCkgfHwgcGFyc2VkLmxlbmd0aCAhPT0gSElTVE9SWV9ERUZBVUxUX0NPTF9XSURUSFMubGVuZ3RoKSByZXR1cm4gbnVsbDsKICAgICAgcmV0dXJuIGNsYW1wSGlzdG9yeVdpZHRocyhwYXJzZWQpOwogICAgfSBjYXRjaCAoZSkgewogICAgICBjb25zb2xlLmVycm9yKCdbUmFkYXJNRVBdIGFuY2hvcyBkZSBjb2x1bW5hcyBpbnbDoWxpZG9zJywgZSk7CiAgICAgIHJldHVybiBudWxsOwogICAgfQogIH0KICBmdW5jdGlvbiBhcHBseUhpc3RvcnlDb2x1bW5XaWR0aHMod2lkdGhzLCBwZXJzaXN0ID0gZmFsc2UpIHsKICAgIGNvbnN0IGNvbHMgPSBnZXRIaXN0b3J5Q29sRWxlbWVudHMoKTsKICAgIGlmIChjb2xzLmxlbmd0aCAhPT0gSElTVE9SWV9ERUZBVUxUX0NPTF9XSURUSFMubGVuZ3RoKSByZXR1cm47CiAgICBjb25zdCBuZXh0ID0gY2xhbXBIaXN0b3J5V2lkdGhzKHdpZHRocyk7CiAgICBjb2xzLmZvckVhY2goKGNvbCwgaSkgPT4gewogICAgICBjb2wuc3R5bGUud2lkdGggPSBgJHtuZXh0W2ldfXB4YDsKICAgIH0pOwogICAgc3RhdGUuaGlzdG9yeUNvbFdpZHRocyA9IG5leHQ7CiAgICBpZiAocGVyc2lzdCkgc2F2ZUhpc3RvcnlDb2x1bW5XaWR0aHMobmV4dCk7CiAgfQogIGZ1bmN0aW9uIGluaXRIaXN0b3J5Q29sdW1uV2lkdGhzKCkgewogICAgY29uc3Qgc2F2ZWQgPSBsb2FkSGlzdG9yeUNvbHVtbldpZHRocygpOwogICAgYXBwbHlIaXN0b3J5Q29sdW1uV2lkdGhzKHNhdmVkIHx8IEhJU1RPUllfREVGQVVMVF9DT0xfV0lEVEhTLCBmYWxzZSk7CiAgfQogIGZ1bmN0aW9uIGJpbmRIaXN0b3J5Q29sdW1uUmVzaXplKCkgewogICAgaWYgKHN0YXRlLmhpc3RvcnlSZXNpemVCb3VuZCkgcmV0dXJuOwogICAgY29uc3QgdGFibGUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGlzdG9yeS10YWJsZScpOwogICAgaWYgKCF0YWJsZSkgcmV0dXJuOwogICAgY29uc3QgaGFuZGxlcyA9IEFycmF5LmZyb20odGFibGUucXVlcnlTZWxlY3RvckFsbCgnLmNvbC1yZXNpemVyJykpOwogICAgaWYgKCFoYW5kbGVzLmxlbmd0aCkgcmV0dXJuOwogICAgc3RhdGUuaGlzdG9yeVJlc2l6ZUJvdW5kID0gdHJ1ZTsKCiAgICBoYW5kbGVzLmZvckVhY2goKGhhbmRsZSkgPT4gewogICAgICBoYW5kbGUuYWRkRXZlbnRMaXN0ZW5lcignZGJsY2xpY2snLCAoZXZlbnQpID0+IHsKICAgICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgIGNvbnN0IGlkeCA9IE51bWJlcihoYW5kbGUuZGF0YXNldC5jb2xJbmRleCk7CiAgICAgICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoaWR4KSkgcmV0dXJuOwogICAgICAgIGNvbnN0IG5leHQgPSBzdGF0ZS5oaXN0b3J5Q29sV2lkdGhzLnNsaWNlKCk7CiAgICAgICAgbmV4dFtpZHhdID0gSElTVE9SWV9ERUZBVUxUX0NPTF9XSURUSFNbaWR4XTsKICAgICAgICBhcHBseUhpc3RvcnlDb2x1bW5XaWR0aHMobmV4dCwgdHJ1ZSk7CiAgICAgIH0pOwogICAgICBoYW5kbGUuYWRkRXZlbnRMaXN0ZW5lcigncG9pbnRlcmRvd24nLCAoZXZlbnQpID0+IHsKICAgICAgICBpZiAoZXZlbnQuYnV0dG9uICE9PSAwKSByZXR1cm47CiAgICAgICAgY29uc3QgaWR4ID0gTnVtYmVyKGhhbmRsZS5kYXRhc2V0LmNvbEluZGV4KTsKICAgICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShpZHgpKSByZXR1cm47CiAgICAgICAgY29uc3Qgc3RhcnRYID0gZXZlbnQuY2xpZW50WDsKICAgICAgICBjb25zdCBzdGFydFdpZHRoID0gc3RhdGUuaGlzdG9yeUNvbFdpZHRoc1tpZHhdID8/IEhJU1RPUllfREVGQVVMVF9DT0xfV0lEVEhTW2lkeF07CiAgICAgICAgaGFuZGxlLmNsYXNzTGlzdC5hZGQoJ2FjdGl2ZScpOwogICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7CgogICAgICAgIGNvbnN0IG9uTW92ZSA9IChtb3ZlRXZlbnQpID0+IHsKICAgICAgICAgIGNvbnN0IGRlbHRhID0gbW92ZUV2ZW50LmNsaWVudFggLSBzdGFydFg7CiAgICAgICAgICBjb25zdCBtaW4gPSBISVNUT1JZX01JTl9DT0xfV0lEVEhTW2lkeF0gPz8gODA7CiAgICAgICAgICBjb25zdCBuZXh0V2lkdGggPSBNYXRoLm1heChtaW4sIE1hdGgucm91bmQoc3RhcnRXaWR0aCArIGRlbHRhKSk7CiAgICAgICAgICBjb25zdCBuZXh0ID0gc3RhdGUuaGlzdG9yeUNvbFdpZHRocy5zbGljZSgpOwogICAgICAgICAgbmV4dFtpZHhdID0gbmV4dFdpZHRoOwogICAgICAgICAgYXBwbHlIaXN0b3J5Q29sdW1uV2lkdGhzKG5leHQsIGZhbHNlKTsKICAgICAgICB9OwogICAgICAgIGNvbnN0IG9uVXAgPSAoKSA9PiB7CiAgICAgICAgICB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcigncG9pbnRlcm1vdmUnLCBvbk1vdmUpOwogICAgICAgICAgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJ1cCcsIG9uVXApOwogICAgICAgICAgaGFuZGxlLmNsYXNzTGlzdC5yZW1vdmUoJ2FjdGl2ZScpOwogICAgICAgICAgc2F2ZUhpc3RvcnlDb2x1bW5XaWR0aHMoc3RhdGUuaGlzdG9yeUNvbFdpZHRocyk7CiAgICAgICAgfTsKICAgICAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigncG9pbnRlcm1vdmUnLCBvbk1vdmUpOwogICAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdwb2ludGVydXAnLCBvblVwKTsKICAgICAgfSk7CiAgICB9KTsKICB9CgogIC8vIDMpIEZ1bmNpb25lcyBkZSByZW5kZXIKICBmdW5jdGlvbiByZW5kZXJNZXBDY2wocGF5bG9hZCkgewogICAgaWYgKCFwYXlsb2FkKSB7CiAgICAgIHNldERhc2goWydtZXAtdmFsJywgJ2NjbC12YWwnLCAnYnJlY2hhLWFicycsICdicmVjaGEtcGN0J10pOwogICAgICBzZXRUZXh0KCdzdGF0dXMtbGFiZWwnLCAnRGF0b3MgaW5jb21wbGV0b3MnKTsKICAgICAgc2V0VGV4dCgnc3RhdHVzLWJhZGdlJywgJ1NpbiBkYXRvJyk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IGRhdGEgPSBleHRyYWN0Um9vdChwYXlsb2FkKTsKICAgIGNvbnN0IGN1cnJlbnQgPSBkYXRhICYmIHR5cGVvZiBkYXRhLmN1cnJlbnQgPT09ICdvYmplY3QnID8gZGF0YS5jdXJyZW50IDogbnVsbDsKICAgIGNvbnN0IG1lcCA9IGN1cnJlbnQgPyB0b051bWJlcihjdXJyZW50Lm1lcCkgOiAocGlja051bWJlcihkYXRhLCBbWydtZXAnLCAndmVudGEnXSwgWydtZXAnLCAnc2VsbCddLCBbJ21lcCddLCBbJ21lcF92ZW50YSddLCBbJ2RvbGFyX21lcCddXSkgPz8gcGlja0J5S2V5SGludChkYXRhLCAnbWVwJykpOwogICAgY29uc3QgY2NsID0gY3VycmVudCA/IHRvTnVtYmVyKGN1cnJlbnQuY2NsKSA6IChwaWNrTnVtYmVyKGRhdGEsIFtbJ2NjbCcsICd2ZW50YSddLCBbJ2NjbCcsICdzZWxsJ10sIFsnY2NsJ10sIFsnY2NsX3ZlbnRhJ10sIFsnZG9sYXJfY2NsJ11dKSA/PyBwaWNrQnlLZXlIaW50KGRhdGEsICdjY2wnKSk7CiAgICBjb25zdCBhYnMgPSBjdXJyZW50ID8gdG9OdW1iZXIoY3VycmVudC5hYnNEaWZmKSA/PyAobWVwICE9PSBudWxsICYmIGNjbCAhPT0gbnVsbCA/IE1hdGguYWJzKG1lcCAtIGNjbCkgOiBudWxsKSA6IChtZXAgIT09IG51bGwgJiYgY2NsICE9PSBudWxsID8gTWF0aC5hYnMobWVwIC0gY2NsKSA6IG51bGwpOwogICAgY29uc3QgcGN0ID0gY3VycmVudCA/IHRvTnVtYmVyKGN1cnJlbnQucGN0RGlmZikgPz8gYnJlY2hhUGVyY2VudChtZXAsIGNjbCkgOiBicmVjaGFQZXJjZW50KG1lcCwgY2NsKTsKICAgIGNvbnN0IGlzU2ltaWxhciA9IGN1cnJlbnQgJiYgdHlwZW9mIGN1cnJlbnQuc2ltaWxhciA9PT0gJ2Jvb2xlYW4nCiAgICAgID8gY3VycmVudC5zaW1pbGFyCiAgICAgIDogKHBjdCAhPT0gbnVsbCAmJiBhYnMgIT09IG51bGwgJiYgKHBjdCA8PSBTSU1JTEFSX1BDVF9USFJFU0hPTEQgfHwgYWJzIDw9IFNJTUlMQVJfQVJTX1RIUkVTSE9MRCkpOwoKICAgIHNldFRleHQoJ21lcC12YWwnLCBmb3JtYXRNb25leShtZXAsIDIpLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc2V0VGV4dCgnY2NsLXZhbCcsIGZvcm1hdE1vbmV5KGNjbCwgMiksIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdicmVjaGEtYWJzJywgYWJzID09PSBudWxsID8gJ+KAlCcgOiBmb3JtYXRNb25leShhYnMsIDIpLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc2V0VGV4dCgnYnJlY2hhLXBjdCcsIGZvcm1hdFBlcmNlbnQocGN0LCAyKSwgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ3N0YXR1cy1sYWJlbCcsIGlzU2ltaWxhciA/ICdNRVAg4omIIENDTCcgOiAnTUVQIOKJoCBDQ0wnKTsKICAgIHNldFRleHQoJ3N0YXR1cy1iYWRnZScsIGlzU2ltaWxhciA/ICdTaW1pbGFyJyA6ICdObyBzaW1pbGFyJyk7CiAgICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzdGF0dXMtYmFkZ2UnKTsKICAgIGlmIChiYWRnZSkgYmFkZ2UuY2xhc3NMaXN0LnRvZ2dsZSgnbm9zaW0nLCAhaXNTaW1pbGFyKTsKCiAgICBjb25zdCBiYW5uZXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3RhdHVzLWJhbm5lcicpOwogICAgaWYgKGJhbm5lcikgewogICAgICBiYW5uZXIuY2xhc3NMaXN0LnRvZ2dsZSgnc2ltaWxhcicsICEhaXNTaW1pbGFyKTsKICAgICAgYmFubmVyLmNsYXNzTGlzdC50b2dnbGUoJ25vLXNpbWlsYXInLCAhaXNTaW1pbGFyKTsKICAgIH0KICAgIGNvbnN0IHN1YiA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJyNzdGF0dXMtYmFubmVyIC5zLXN1YicpOwogICAgaWYgKHN1YikgewogICAgICBzdWIudGV4dENvbnRlbnQgPSBpc1NpbWlsYXIKICAgICAgICA/ICdMYSBicmVjaGEgZXN0w6EgZGVudHJvIGRlbCB1bWJyYWwg4oCUIGxvcyBwcmVjaW9zIHNvbiBjb21wYXJhYmxlcycKICAgICAgICA6ICdMYSBicmVjaGEgc3VwZXJhIGVsIHVtYnJhbCDigJQgbG9zIHByZWNpb3Mgbm8gc29uIGNvbXBhcmFibGVzJzsKICAgIH0KICAgIGNvbnN0IGlzT3BlbiA9IGRhdGE/Lm1hcmtldCAmJiB0eXBlb2YgZGF0YS5tYXJrZXQuaXNPcGVuID09PSAnYm9vbGVhbicgPyBkYXRhLm1hcmtldC5pc09wZW4gOiBudWxsOwogICAgaWYgKGlzT3BlbiAhPT0gbnVsbCkgc2V0TWFya2V0VGFnKGlzT3Blbik7CiAgICBzdGF0ZS5sYXRlc3QubWVwID0gbWVwOwogICAgc3RhdGUubGF0ZXN0LmNjbCA9IGNjbDsKICAgIHN0YXRlLmxhdGVzdC5icmVjaGFBYnMgPSBhYnM7CiAgICBzdGF0ZS5sYXRlc3QuYnJlY2hhUGN0ID0gcGN0OwogIH0KCiAgZnVuY3Rpb24gaXNTaW1pbGFyUm93KHJvdykgewogICAgY29uc3QgYWJzID0gcm93LmFic19kaWZmICE9IG51bGwgPyByb3cuYWJzX2RpZmYgOiBNYXRoLmFicyhyb3cubWVwIC0gcm93LmNjbCk7CiAgICBjb25zdCBwY3QgPSByb3cucGN0X2RpZmYgIT0gbnVsbCA/IHJvdy5wY3RfZGlmZiA6IGNhbGNCcmVjaGFQY3Qocm93Lm1lcCwgcm93LmNjbCk7CiAgICByZXR1cm4gKE51bWJlci5pc0Zpbml0ZShwY3QpICYmIHBjdCA8PSBTSU1JTEFSX1BDVF9USFJFU0hPTEQpIHx8IChOdW1iZXIuaXNGaW5pdGUoYWJzKSAmJiBhYnMgPD0gU0lNSUxBUl9BUlNfVEhSRVNIT0xEKTsKICB9CgogIGZ1bmN0aW9uIGZpbHRlckRlc2NyaXB0b3IobW9kZSA9IHN0YXRlLmZpbHRlck1vZGUpIHsKICAgIGlmIChtb2RlID09PSAnMW0nKSByZXR1cm4gJzEgTWVzJzsKICAgIGlmIChtb2RlID09PSAnMXcnKSByZXR1cm4gJzEgU2VtYW5hJzsKICAgIHJldHVybiAnMSBEw61hJzsKICB9CgogIGZ1bmN0aW9uIHJlbmRlck1ldHJpY3MyNGgocGF5bG9hZCkgewogICAgY29uc3QgZmlsdGVyZWQgPSBmaWx0ZXJIaXN0b3J5Um93cyhleHRyYWN0SGlzdG9yeVJvd3MocGF5bG9hZCksIHN0YXRlLmZpbHRlck1vZGUpOwogICAgY29uc3QgcGN0VmFsdWVzID0gZmlsdGVyZWQubWFwKChyKSA9PiAoci5wY3RfZGlmZiAhPSBudWxsID8gci5wY3RfZGlmZiA6IGNhbGNCcmVjaGFQY3Qoci5tZXAsIHIuY2NsKSkpLmZpbHRlcigodikgPT4gTnVtYmVyLmlzRmluaXRlKHYpKTsKICAgIGNvbnN0IHNpbWlsYXJDb3VudCA9IGZpbHRlcmVkLmZpbHRlcigocikgPT4gaXNTaW1pbGFyUm93KHIpKS5sZW5ndGg7CiAgICBjb25zdCBkZXNjcmlwdG9yID0gZmlsdGVyRGVzY3JpcHRvcigpOwoKICAgIHNldFRleHQoJ21ldHJpYy1jb3VudC1sYWJlbCcsIGBNdWVzdHJhcyAke2Rlc2NyaXB0b3J9YCk7CiAgICBzZXRUZXh0KCdtZXRyaWMtY291bnQtMjRoJywgU3RyaW5nKGZpbHRlcmVkLmxlbmd0aCksIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdtZXRyaWMtY291bnQtc3ViJywgJ3JlZ2lzdHJvcyBkZWwgcGVyw61vZG8gZmlsdHJhZG8nKTsKICAgIHNldFRleHQoJ21ldHJpYy1zaW1pbGFyLWxhYmVsJywgYFZlY2VzIHNpbWlsYXIgKCR7ZGVzY3JpcHRvcn0pYCk7CiAgICBzZXRUZXh0KCdtZXRyaWMtc2ltaWxhci0yNGgnLCBTdHJpbmcoc2ltaWxhckNvdW50KSwgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ21ldHJpYy1zaW1pbGFyLXN1YicsICdtb21lbnRvcyBlbiB6b25hIOKJpDElIG8g4omkJDEwJyk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWluLWxhYmVsJywgYEJyZWNoYSBtw61uLiAoJHtkZXNjcmlwdG9yfSlgKTsKICAgIHNldFRleHQoJ21ldHJpYy1taW4tMjRoJywgcGN0VmFsdWVzLmxlbmd0aCA/IGZvcm1hdFBlcmNlbnQoTWF0aC5taW4oLi4ucGN0VmFsdWVzKSwgMikgOiAn4oCUJywgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ21ldHJpYy1taW4tc3ViJywgJ23DrW5pbWEgZGVsIHBlcsOtb2RvIGZpbHRyYWRvJyk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWF4LWxhYmVsJywgYEJyZWNoYSBtw6F4LiAoJHtkZXNjcmlwdG9yfSlgKTsKICAgIHNldFRleHQoJ21ldHJpYy1tYXgtMjRoJywgcGN0VmFsdWVzLmxlbmd0aCA/IGZvcm1hdFBlcmNlbnQoTWF0aC5tYXgoLi4ucGN0VmFsdWVzKSwgMikgOiAn4oCUJywgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ21ldHJpYy1tYXgtc3ViJywgJ23DoXhpbWEgZGVsIHBlcsOtb2RvIGZpbHRyYWRvJyk7CiAgICBzZXRUZXh0KCd0cmVuZC10aXRsZScsIGBUZW5kZW5jaWEgTUVQL0NDTCDigJQgJHtkZXNjcmlwdG9yfWApOwogIH0KCiAgZnVuY3Rpb24gcm93SG91ckxhYmVsKGVwb2NoKSB7CiAgICBjb25zdCBuID0gdG9OdW1iZXIoZXBvY2gpOwogICAgaWYgKG4gPT09IG51bGwpIHJldHVybiAn4oCUJzsKICAgIHJldHVybiBmbXRBcmdIb3VyLmZvcm1hdChuZXcgRGF0ZShuICogMTAwMCkpOwogIH0KICBmdW5jdGlvbiByb3dEYXlIb3VyTGFiZWwoZXBvY2gpIHsKICAgIGNvbnN0IG4gPSB0b051bWJlcihlcG9jaCk7CiAgICBpZiAobiA9PT0gbnVsbCkgcmV0dXJuICfigJQnOwogICAgY29uc3QgZGF0ZSA9IG5ldyBEYXRlKG4gKiAxMDAwKTsKICAgIHJldHVybiBgJHtmbXRBcmdEYXlNb250aC5mb3JtYXQoZGF0ZSl9ICR7Zm10QXJnSG91ci5mb3JtYXQoZGF0ZSl9YDsKICB9CiAgZnVuY3Rpb24gYXJ0RGF0ZUtleShlcG9jaCkgewogICAgY29uc3QgbiA9IHRvTnVtYmVyKGVwb2NoKTsKICAgIGlmIChuID09PSBudWxsKSByZXR1cm4gbnVsbDsKICAgIHJldHVybiBmbXRBcmdEYXRlLmZvcm1hdChuZXcgRGF0ZShuICogMTAwMCkpOwogIH0KICBmdW5jdGlvbiBhcnRXZWVrZGF5KGVwb2NoKSB7CiAgICBjb25zdCBuID0gdG9OdW1iZXIoZXBvY2gpOwogICAgaWYgKG4gPT09IG51bGwpIHJldHVybiBudWxsOwogICAgcmV0dXJuIGZtdEFyZ1dlZWtkYXkuZm9ybWF0KG5ldyBEYXRlKG4gKiAxMDAwKSk7CiAgfQogIGZ1bmN0aW9uIGV4dHJhY3RIaXN0b3J5Um93cyhwYXlsb2FkKSB7CiAgICBjb25zdCBkYXRhID0gZXh0cmFjdFJvb3QocGF5bG9hZCk7CiAgICBjb25zdCByb3dzID0gQXJyYXkuaXNBcnJheShkYXRhLmhpc3RvcnkpID8gZGF0YS5oaXN0b3J5LnNsaWNlKCkgOiBbXTsKICAgIHJldHVybiByb3dzCiAgICAgIC5tYXAoKHIpID0+ICh7CiAgICAgICAgZXBvY2g6IHRvTnVtYmVyKHIuZXBvY2gpLAogICAgICAgIG1lcDogdG9OdW1iZXIoci5tZXApLAogICAgICAgIGNjbDogdG9OdW1iZXIoci5jY2wpLAogICAgICAgIGFic19kaWZmOiB0b051bWJlcihyLmFic19kaWZmKSwKICAgICAgICBwY3RfZGlmZjogdG9OdW1iZXIoci5wY3RfZGlmZiksCiAgICAgICAgc2ltaWxhcjogQm9vbGVhbihyLnNpbWlsYXIpCiAgICAgIH0pKQogICAgICAuZmlsdGVyKChyKSA9PiByLmVwb2NoICE9IG51bGwgJiYgci5tZXAgIT0gbnVsbCAmJiByLmNjbCAhPSBudWxsKQogICAgICAuc29ydCgoYSwgYikgPT4gYS5lcG9jaCAtIGIuZXBvY2gpOwogIH0KICBmdW5jdGlvbiBmaWx0ZXJIaXN0b3J5Um93cyhyb3dzLCBtb2RlKSB7CiAgICBpZiAoIXJvd3MubGVuZ3RoKSByZXR1cm4gW107CiAgICBjb25zdCBsYXRlc3RFcG9jaCA9IHJvd3Nbcm93cy5sZW5ndGggLSAxXS5lcG9jaDsKICAgIGlmIChtb2RlID09PSAnMW0nKSB7CiAgICAgIGNvbnN0IGN1dG9mZiA9IGxhdGVzdEVwb2NoIC0gKDMwICogMjQgKiAzNjAwKTsKICAgICAgcmV0dXJuIHJvd3MuZmlsdGVyKChyKSA9PiByLmVwb2NoID49IGN1dG9mZik7CiAgICB9CiAgICBpZiAobW9kZSA9PT0gJzF3JykgewogICAgICBjb25zdCBhbGxvd2VkRGF5cyA9IG5ldyBTZXQoKTsKICAgICAgZm9yIChsZXQgaSA9IHJvd3MubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHsKICAgICAgICBjb25zdCBkYXkgPSBhcnREYXRlS2V5KHJvd3NbaV0uZXBvY2gpOwogICAgICAgIGNvbnN0IHdkID0gYXJ0V2Vla2RheShyb3dzW2ldLmVwb2NoKTsKICAgICAgICBpZiAoIWRheSB8fCB3ZCA9PT0gJ1NhdCcgfHwgd2QgPT09ICdTdW4nKSBjb250aW51ZTsKICAgICAgICBhbGxvd2VkRGF5cy5hZGQoZGF5KTsKICAgICAgICBpZiAoYWxsb3dlZERheXMuc2l6ZSA+PSA1KSBicmVhazsKICAgICAgfQogICAgICByZXR1cm4gcm93cy5maWx0ZXIoKHIpID0+IHsKICAgICAgICBjb25zdCBkYXkgPSBhcnREYXRlS2V5KHIuZXBvY2gpOwogICAgICAgIHJldHVybiBkYXkgJiYgYWxsb3dlZERheXMuaGFzKGRheSk7CiAgICAgIH0pOwogICAgfQogICAgY29uc3QgY3V0b2ZmID0gbGF0ZXN0RXBvY2ggLSAoMjQgKiAzNjAwKTsKICAgIHJldHVybiByb3dzLmZpbHRlcigocikgPT4gci5lcG9jaCA+PSBjdXRvZmYpOwogIH0KICBmdW5jdGlvbiBkb3duc2FtcGxlUm93cyhyb3dzLCBtYXhQb2ludHMpIHsKICAgIGlmIChyb3dzLmxlbmd0aCA8PSBtYXhQb2ludHMpIHJldHVybiByb3dzOwogICAgY29uc3Qgb3V0ID0gW107CiAgICBjb25zdCBzdGVwID0gKHJvd3MubGVuZ3RoIC0gMSkgLyAobWF4UG9pbnRzIC0gMSk7CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IG1heFBvaW50czsgaSsrKSB7CiAgICAgIG91dC5wdXNoKHJvd3NbTWF0aC5yb3VuZChpICogc3RlcCldKTsKICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQogIGZ1bmN0aW9uIGN1cnJlbnRGaWx0ZXJMYWJlbCgpIHsKICAgIGlmIChzdGF0ZS5maWx0ZXJNb2RlID09PSAnMW0nKSByZXR1cm4gJzEgTWVzJzsKICAgIGlmIChzdGF0ZS5maWx0ZXJNb2RlID09PSAnMXcnKSByZXR1cm4gJzEgU2VtYW5hJzsKICAgIHJldHVybiAnMSBEw61hJzsKICB9CiAgZnVuY3Rpb24gYXBwbHlGaWx0ZXIobW9kZSkgewogICAgc3RhdGUuZmlsdGVyTW9kZSA9IG1vZGU7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcucGlsbFtkYXRhLWZpbHRlcl0nKS5mb3JFYWNoKChidG4pID0+IHsKICAgICAgYnRuLmNsYXNzTGlzdC50b2dnbGUoJ29uJywgYnRuLmRhdGFzZXQuZmlsdGVyID09PSBtb2RlKTsKICAgIH0pOwogICAgaWYgKHN0YXRlLmxhc3RNZXBQYXlsb2FkKSB7CiAgICAgIHJlbmRlclRyZW5kKHN0YXRlLmxhc3RNZXBQYXlsb2FkKTsKICAgICAgcmVuZGVySGlzdG9yeShzdGF0ZS5sYXN0TWVwUGF5bG9hZCk7CiAgICAgIHJlbmRlck1ldHJpY3MyNGgoc3RhdGUubGFzdE1lcFBheWxvYWQpOwogICAgfQogIH0KCiAgZnVuY3Rpb24gcmVuZGVySGlzdG9yeShwYXlsb2FkKSB7CiAgICBjb25zdCB0Ym9keSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoaXN0b3J5LXJvd3MnKTsKICAgIGNvbnN0IGNhcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoaXN0b3J5LWNhcCcpOwogICAgaWYgKCF0Ym9keSkgcmV0dXJuOwogICAgY29uc3QgZmlsdGVyZWQgPSBmaWx0ZXJIaXN0b3J5Um93cyhleHRyYWN0SGlzdG9yeVJvd3MocGF5bG9hZCksIHN0YXRlLmZpbHRlck1vZGUpOwogICAgY29uc3Qgcm93cyA9IGZpbHRlcmVkLnNsaWNlKCkucmV2ZXJzZSgpOwogICAgaWYgKGNhcCkgY2FwLnRleHRDb250ZW50ID0gYCR7Y3VycmVudEZpbHRlckxhYmVsKCl9IMK3ICR7cm93cy5sZW5ndGh9IHJlZ2lzdHJvc2A7CiAgICBpZiAoIXJvd3MubGVuZ3RoKSB7CiAgICAgIHRib2R5LmlubmVySFRNTCA9ICc8dHI+PHRkIGNsYXNzPSJkaW0iIGNvbHNwYW49IjYiPlNpbiByZWdpc3Ryb3MgdG9kYXbDrWE8L3RkPjwvdHI+JzsKICAgICAgcmV0dXJuOwogICAgfQogICAgdGJvZHkuaW5uZXJIVE1MID0gcm93cy5tYXAoKHIpID0+IHsKICAgICAgY29uc3QgbWVwID0gdG9OdW1iZXIoci5tZXApOwogICAgICBjb25zdCBjY2wgPSB0b051bWJlcihyLmNjbCk7CiAgICAgIGNvbnN0IGFicyA9IHRvTnVtYmVyKHIuYWJzX2RpZmYpOwogICAgICBjb25zdCBwY3QgPSB0b051bWJlcihyLnBjdF9kaWZmKTsKICAgICAgY29uc3Qgc2ltID0gQm9vbGVhbihyLnNpbWlsYXIpOwogICAgICByZXR1cm4gYDx0cj4KICAgICAgICA8dGQgY2xhc3M9ImRpbSI+PGRpdiBjbGFzcz0idHMtZGF5Ij4ke2ZtdEFyZ0RheU1vbnRoLmZvcm1hdChuZXcgRGF0ZShyLmVwb2NoICogMTAwMCkpfTwvZGl2PjxkaXYgY2xhc3M9InRzLWhvdXIiPiR7cm93SG91ckxhYmVsKHIuZXBvY2gpfTwvZGl2PjwvdGQ+CiAgICAgICAgPHRkIHN0eWxlPSJjb2xvcjp2YXIoLS1tZXApIj4ke2Zvcm1hdE1vbmV5KG1lcCwgMil9PC90ZD4KICAgICAgICA8dGQgc3R5bGU9ImNvbG9yOnZhcigtLWNjbCkiPiR7Zm9ybWF0TW9uZXkoY2NsLCAyKX08L3RkPgogICAgICAgIDx0ZD4ke2Zvcm1hdE1vbmV5KGFicywgMil9PC90ZD4KICAgICAgICA8dGQ+JHtmb3JtYXRQZXJjZW50KHBjdCwgMil9PC90ZD4KICAgICAgICA8dGQ+PHNwYW4gY2xhc3M9InNiYWRnZSAke3NpbSA/ICdzaW0nIDogJ25vc2ltJ30iPiR7c2ltID8gJ1NpbWlsYXInIDogJ05vIHNpbWlsYXInfTwvc3Bhbj48L3RkPgogICAgICA8L3RyPmA7CiAgICB9KS5qb2luKCcnKTsKICB9CgogIGZ1bmN0aW9uIGxpbmVQb2ludHModmFsdWVzLCB4MCwgeDEsIHkwLCB5MSwgbWluVmFsdWUsIG1heFZhbHVlKSB7CiAgICBpZiAoIXZhbHVlcy5sZW5ndGgpIHJldHVybiAnJzsKICAgIGNvbnN0IG1pbiA9IE51bWJlci5pc0Zpbml0ZShtaW5WYWx1ZSkgPyBtaW5WYWx1ZSA6IE1hdGgubWluKC4uLnZhbHVlcyk7CiAgICBjb25zdCBtYXggPSBOdW1iZXIuaXNGaW5pdGUobWF4VmFsdWUpID8gbWF4VmFsdWUgOiBNYXRoLm1heCguLi52YWx1ZXMpOwogICAgY29uc3Qgc3BhbiA9IE1hdGgubWF4KDAuMDAwMDAxLCBtYXggLSBtaW4pOwogICAgcmV0dXJuIHZhbHVlcy5tYXAoKHYsIGkpID0+IHsKICAgICAgY29uc3QgeCA9IHgwICsgKCh4MSAtIHgwKSAqIGkgLyBNYXRoLm1heCgxLCB2YWx1ZXMubGVuZ3RoIC0gMSkpOwogICAgICBjb25zdCB5ID0geTEgLSAoKHYgLSBtaW4pIC8gc3BhbikgKiAoeTEgLSB5MCk7CiAgICAgIHJldHVybiBgJHt4LnRvRml4ZWQoMil9LCR7eS50b0ZpeGVkKDIpfWA7CiAgICB9KS5qb2luKCcgJyk7CiAgfQogIGZ1bmN0aW9uIHZhbHVlVG9ZKHZhbHVlLCB5MCwgeTEsIG1pblZhbHVlLCBtYXhWYWx1ZSkgewogICAgY29uc3Qgc3BhbiA9IE1hdGgubWF4KDAuMDAwMDAxLCBtYXhWYWx1ZSAtIG1pblZhbHVlKTsKICAgIHJldHVybiB5MSAtICgodmFsdWUgLSBtaW5WYWx1ZSkgLyBzcGFuKSAqICh5MSAtIHkwKTsKICB9CiAgZnVuY3Rpb24gY2FsY0JyZWNoYVBjdChtZXAsIGNjbCkgewogICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUobWVwKSB8fCAhTnVtYmVyLmlzRmluaXRlKGNjbCkpIHJldHVybiBudWxsOwogICAgY29uc3QgYXZnID0gKG1lcCArIGNjbCkgLyAyOwogICAgaWYgKCFhdmcpIHJldHVybiBudWxsOwogICAgcmV0dXJuIChNYXRoLmFicyhtZXAgLSBjY2wpIC8gYXZnKSAqIDEwMDsKICB9CiAgZnVuY3Rpb24gaGlkZVRyZW5kSG92ZXIoKSB7CiAgICBjb25zdCB0aXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtdG9vbHRpcCcpOwogICAgY29uc3QgbGluZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1ob3Zlci1saW5lJyk7CiAgICBjb25zdCBtZXBEb3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtaG92ZXItbWVwJyk7CiAgICBjb25zdCBjY2xEb3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtaG92ZXItY2NsJyk7CiAgICBpZiAodGlwKSB0aXAuc2V0QXR0cmlidXRlKCdvcGFjaXR5JywgJzAnKTsKICAgIGlmIChsaW5lKSBsaW5lLnNldEF0dHJpYnV0ZSgnb3BhY2l0eScsICcwJyk7CiAgICBpZiAobWVwRG90KSBtZXBEb3Quc2V0QXR0cmlidXRlKCdvcGFjaXR5JywgJzAnKTsKICAgIGlmIChjY2xEb3QpIGNjbERvdC5zZXRBdHRyaWJ1dGUoJ29wYWNpdHknLCAnMCcpOwogIH0KICBmdW5jdGlvbiByZW5kZXJUcmVuZEhvdmVyKHBvaW50KSB7CiAgICBjb25zdCB0aXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtdG9vbHRpcCcpOwogICAgY29uc3QgYmcgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtdG9vbHRpcC1iZycpOwogICAgY29uc3QgbGluZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1ob3Zlci1saW5lJyk7CiAgICBjb25zdCBtZXBEb3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtaG92ZXItbWVwJyk7CiAgICBjb25zdCBjY2xEb3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtaG92ZXItY2NsJyk7CiAgICBpZiAoIXRpcCB8fCAhYmcgfHwgIWxpbmUgfHwgIW1lcERvdCB8fCAhY2NsRG90IHx8ICFwb2ludCkgcmV0dXJuOwoKICAgIGxpbmUuc2V0QXR0cmlidXRlKCd4MScsIHBvaW50LngudG9GaXhlZCgyKSk7CiAgICBsaW5lLnNldEF0dHJpYnV0ZSgneDInLCBwb2ludC54LnRvRml4ZWQoMikpOwogICAgbGluZS5zZXRBdHRyaWJ1dGUoJ29wYWNpdHknLCAnMScpOwogICAgbWVwRG90LnNldEF0dHJpYnV0ZSgnY3gnLCBwb2ludC54LnRvRml4ZWQoMikpOwogICAgbWVwRG90LnNldEF0dHJpYnV0ZSgnY3knLCBwb2ludC5tZXBZLnRvRml4ZWQoMikpOwogICAgbWVwRG90LnNldEF0dHJpYnV0ZSgnb3BhY2l0eScsICcxJyk7CiAgICBjY2xEb3Quc2V0QXR0cmlidXRlKCdjeCcsIHBvaW50LngudG9GaXhlZCgyKSk7CiAgICBjY2xEb3Quc2V0QXR0cmlidXRlKCdjeScsIHBvaW50LmNjbFkudG9GaXhlZCgyKSk7CiAgICBjY2xEb3Quc2V0QXR0cmlidXRlKCdvcGFjaXR5JywgJzEnKTsKCiAgICBzZXRUZXh0KCd0cmVuZC10aXAtdGltZScsIHJvd0RheUhvdXJMYWJlbChwb2ludC5lcG9jaCkpOwogICAgc2V0VGV4dCgndHJlbmQtdGlwLW1lcCcsIGBNRVAgJHtmb3JtYXRNb25leShwb2ludC5tZXAsIDIpfWApOwogICAgc2V0VGV4dCgndHJlbmQtdGlwLWNjbCcsIGBDQ0wgJHtmb3JtYXRNb25leShwb2ludC5jY2wsIDIpfWApOwogICAgc2V0VGV4dCgndHJlbmQtdGlwLWdhcCcsIGBCcmVjaGEgJHtmb3JtYXRQZXJjZW50KHBvaW50LnBjdCwgMil9YCk7CgogICAgY29uc3QgdGlwVyA9IDE0ODsKICAgIGNvbnN0IHRpcEggPSA1NjsKICAgIGNvbnN0IHRpcFggPSBNYXRoLm1pbig4NDAgLSB0aXBXLCBNYXRoLm1heCgzMCwgcG9pbnQueCArIDEwKSk7CiAgICBjb25zdCB0aXBZID0gTWF0aC5taW4oMTAwLCBNYXRoLm1heCgxOCwgTWF0aC5taW4ocG9pbnQubWVwWSwgcG9pbnQuY2NsWSkgLSB0aXBIIC0gNCkpOwogICAgdGlwLnNldEF0dHJpYnV0ZSgndHJhbnNmb3JtJywgYHRyYW5zbGF0ZSgke3RpcFgudG9GaXhlZCgyKX0gJHt0aXBZLnRvRml4ZWQoMil9KWApOwogICAgYmcuc2V0QXR0cmlidXRlKCd3aWR0aCcsIFN0cmluZyh0aXBXKSk7CiAgICBiZy5zZXRBdHRyaWJ1dGUoJ2hlaWdodCcsIFN0cmluZyh0aXBIKSk7CiAgICB0aXAuc2V0QXR0cmlidXRlKCdvcGFjaXR5JywgJzEnKTsKICB9CiAgZnVuY3Rpb24gYmluZFRyZW5kSG92ZXIoKSB7CiAgICBpZiAoc3RhdGUudHJlbmRIb3ZlckJvdW5kKSByZXR1cm47CiAgICBjb25zdCBjaGFydCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1jaGFydCcpOwogICAgaWYgKCFjaGFydCkgcmV0dXJuOwogICAgc3RhdGUudHJlbmRIb3ZlckJvdW5kID0gdHJ1ZTsKCiAgICBjaGFydC5hZGRFdmVudExpc3RlbmVyKCdtb3VzZWxlYXZlJywgKCkgPT4gaGlkZVRyZW5kSG92ZXIoKSk7CiAgICBjaGFydC5hZGRFdmVudExpc3RlbmVyKCdtb3VzZW1vdmUnLCAoZXZlbnQpID0+IHsKICAgICAgaWYgKCFzdGF0ZS50cmVuZFJvd3MubGVuZ3RoKSByZXR1cm47CiAgICAgIGNvbnN0IGN0bSA9IGNoYXJ0LmdldFNjcmVlbkNUTSgpOwogICAgICBpZiAoIWN0bSkgcmV0dXJuOwogICAgICBjb25zdCBwdCA9IGNoYXJ0LmNyZWF0ZVNWR1BvaW50KCk7CiAgICAgIHB0LnggPSBldmVudC5jbGllbnRYOwogICAgICBwdC55ID0gZXZlbnQuY2xpZW50WTsKICAgICAgY29uc3QgbG9jYWwgPSBwdC5tYXRyaXhUcmFuc2Zvcm0oY3RtLmludmVyc2UoKSk7CiAgICAgIGNvbnN0IHggPSBNYXRoLm1heCgzMCwgTWF0aC5taW4oODQwLCBsb2NhbC54KSk7CiAgICAgIGxldCBuZWFyZXN0ID0gc3RhdGUudHJlbmRSb3dzWzBdOwogICAgICBsZXQgYmVzdCA9IE1hdGguYWJzKG5lYXJlc3QueCAtIHgpOwogICAgICBmb3IgKGxldCBpID0gMTsgaSA8IHN0YXRlLnRyZW5kUm93cy5sZW5ndGg7IGkrKykgewogICAgICAgIGNvbnN0IGQgPSBNYXRoLmFicyhzdGF0ZS50cmVuZFJvd3NbaV0ueCAtIHgpOwogICAgICAgIGlmIChkIDwgYmVzdCkgewogICAgICAgICAgYmVzdCA9IGQ7CiAgICAgICAgICBuZWFyZXN0ID0gc3RhdGUudHJlbmRSb3dzW2ldOwogICAgICAgIH0KICAgICAgfQogICAgICByZW5kZXJUcmVuZEhvdmVyKG5lYXJlc3QpOwogICAgfSk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJUcmVuZChwYXlsb2FkKSB7CiAgICBjb25zdCBoaXN0b3J5ID0gZG93bnNhbXBsZVJvd3MoZmlsdGVySGlzdG9yeVJvd3MoZXh0cmFjdEhpc3RvcnlSb3dzKHBheWxvYWQpLCBzdGF0ZS5maWx0ZXJNb2RlKSwgVFJFTkRfTUFYX1BPSU5UUyk7CiAgICBjb25zdCBtZXBMaW5lID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLW1lcC1saW5lJyk7CiAgICBjb25zdCBjY2xMaW5lID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLWNjbC1saW5lJyk7CiAgICBpZiAoIW1lcExpbmUgfHwgIWNjbExpbmUpIHJldHVybjsKICAgIGJpbmRUcmVuZEhvdmVyKCk7CiAgICBpZiAoIWhpc3RvcnkubGVuZ3RoKSB7CiAgICAgIG1lcExpbmUuc2V0QXR0cmlidXRlKCdwb2ludHMnLCAnJyk7CiAgICAgIGNjbExpbmUuc2V0QXR0cmlidXRlKCdwb2ludHMnLCAnJyk7CiAgICAgIHN0YXRlLnRyZW5kUm93cyA9IFtdOwogICAgICBoaWRlVHJlbmRIb3ZlcigpOwogICAgICBbJ3RyZW5kLXktdG9wJywgJ3RyZW5kLXktbWlkJywgJ3RyZW5kLXktbG93JywgJ3RyZW5kLXgtMScsICd0cmVuZC14LTInLCAndHJlbmQteC0zJywgJ3RyZW5kLXgtNCcsICd0cmVuZC14LTUnXS5mb3JFYWNoKChpZCkgPT4gc2V0VGV4dChpZCwgJ+KAlCcpKTsKICAgICAgcmV0dXJuOwogICAgfQoKICAgIGNvbnN0IHJvd3MgPSBoaXN0b3J5CiAgICAgIC5tYXAoKHIpID0+ICh7CiAgICAgICAgZXBvY2g6IHIuZXBvY2gsCiAgICAgICAgbWVwOiB0b051bWJlcihyLm1lcCksCiAgICAgICAgY2NsOiB0b051bWJlcihyLmNjbCksCiAgICAgICAgcGN0OiB0b051bWJlcihyLnBjdF9kaWZmKQogICAgICB9KSkKICAgICAgLmZpbHRlcigocikgPT4gci5tZXAgIT0gbnVsbCAmJiByLmNjbCAhPSBudWxsKTsKICAgIGlmICghcm93cy5sZW5ndGgpIHJldHVybjsKCiAgICBjb25zdCBtZXBWYWxzID0gcm93cy5tYXAoKHIpID0+IHIubWVwKTsKICAgIGNvbnN0IGNjbFZhbHMgPSByb3dzLm1hcCgocikgPT4gci5jY2wpOwoKICAgIC8vIEVzY2FsYSBjb21wYXJ0aWRhIHBhcmEgTUVQIHkgQ0NMOiBjb21wYXJhY2nDs24gdmlzdWFsIGZpZWwuCiAgICBjb25zdCBhbGxQcmljZVZhbHMgPSBtZXBWYWxzLmNvbmNhdChjY2xWYWxzKTsKICAgIGNvbnN0IHJhd01pbiA9IE1hdGgubWluKC4uLmFsbFByaWNlVmFscyk7CiAgICBjb25zdCByYXdNYXggPSBNYXRoLm1heCguLi5hbGxQcmljZVZhbHMpOwogICAgY29uc3QgcHJpY2VQYWQgPSBNYXRoLm1heCgxLCAocmF3TWF4IC0gcmF3TWluKSAqIDAuMDgpOwogICAgY29uc3QgcHJpY2VNaW4gPSByYXdNaW4gLSBwcmljZVBhZDsKICAgIGNvbnN0IHByaWNlTWF4ID0gcmF3TWF4ICsgcHJpY2VQYWQ7CgogICAgbWVwTGluZS5zZXRBdHRyaWJ1dGUoJ3BvaW50cycsIGxpbmVQb2ludHMobWVwVmFscywgMzAsIDg0MCwgMjUsIDEzMCwgcHJpY2VNaW4sIHByaWNlTWF4KSk7CiAgICBjY2xMaW5lLnNldEF0dHJpYnV0ZSgncG9pbnRzJywgbGluZVBvaW50cyhjY2xWYWxzLCAzMCwgODQwLCAyNSwgMTMwLCBwcmljZU1pbiwgcHJpY2VNYXgpKTsKICAgIHN0YXRlLnRyZW5kUm93cyA9IHJvd3MubWFwKChyLCBpKSA9PiB7CiAgICAgIGNvbnN0IHggPSAzMCArICgoODQwIC0gMzApICogaSAvIE1hdGgubWF4KDEsIHJvd3MubGVuZ3RoIC0gMSkpOwogICAgICByZXR1cm4gewogICAgICAgIGVwb2NoOiByLmVwb2NoLAogICAgICAgIG1lcDogci5tZXAsCiAgICAgICAgY2NsOiByLmNjbCwKICAgICAgICBwY3Q6IGNhbGNCcmVjaGFQY3Qoci5tZXAsIHIuY2NsKSwKICAgICAgICB4LAogICAgICAgIG1lcFk6IHZhbHVlVG9ZKHIubWVwLCAyNSwgMTMwLCBwcmljZU1pbiwgcHJpY2VNYXgpLAogICAgICAgIGNjbFk6IHZhbHVlVG9ZKHIuY2NsLCAyNSwgMTMwLCBwcmljZU1pbiwgcHJpY2VNYXgpCiAgICAgIH07CiAgICB9KTsKICAgIGhpZGVUcmVuZEhvdmVyKCk7CgogICAgY29uc3QgbWlkID0gKHByaWNlTWluICsgcHJpY2VNYXgpIC8gMjsKICAgIHNldFRleHQoJ3RyZW5kLXktdG9wJywgKHByaWNlTWF4IC8gMTAwMCkudG9GaXhlZCgzKSk7CiAgICBzZXRUZXh0KCd0cmVuZC15LW1pZCcsIChtaWQgLyAxMDAwKS50b0ZpeGVkKDMpKTsKICAgIHNldFRleHQoJ3RyZW5kLXktbG93JywgKHByaWNlTWluIC8gMTAwMCkudG9GaXhlZCgzKSk7CgogICAgY29uc3QgaWR4ID0gWzAsIDAuMjUsIDAuNSwgMC43NSwgMV0ubWFwKChwKSA9PiBNYXRoLm1pbihyb3dzLmxlbmd0aCAtIDEsIE1hdGguZmxvb3IoKHJvd3MubGVuZ3RoIC0gMSkgKiBwKSkpOwogICAgY29uc3QgbGFicyA9IGlkeC5tYXAoKGkpID0+IHJvd0RheUhvdXJMYWJlbChyb3dzW2ldPy5lcG9jaCkpOwogICAgc2V0VGV4dCgndHJlbmQteC0xJywgbGFic1swXSB8fCAn4oCUJyk7CiAgICBzZXRUZXh0KCd0cmVuZC14LTInLCBsYWJzWzFdIHx8ICfigJQnKTsKICAgIHNldFRleHQoJ3RyZW5kLXgtMycsIGxhYnNbMl0gfHwgJ+KAlCcpOwogICAgc2V0VGV4dCgndHJlbmQteC00JywgbGFic1szXSB8fCAn4oCUJyk7CiAgICBzZXRUZXh0KCd0cmVuZC14LTUnLCBsYWJzWzRdIHx8ICfigJQnKTsKICB9CgogIC8vIDQpIEZ1bmNpw7NuIGNlbnRyYWwgZmV0Y2hBbGwoKQogIGFzeW5jIGZ1bmN0aW9uIGZldGNoSnNvbih1cmwpIHsKICAgIGNvbnN0IGN0cmwgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7CiAgICBjb25zdCB0aW1lb3V0ID0gc2V0VGltZW91dCgoKSA9PiBjdHJsLmFib3J0KCksIDEyMDAwKTsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKHVybCwgeyBjYWNoZTogJ25vLXN0b3JlJywgc2lnbmFsOiBjdHJsLnNpZ25hbCB9KTsKICAgICAgaWYgKCFyZXMub2spIHRocm93IG5ldyBFcnJvcihgSFRUUCAke3Jlcy5zdGF0dXN9YCk7CiAgICAgIHJldHVybiBhd2FpdCByZXMuanNvbigpOwogICAgfSBmaW5hbGx5IHsKICAgICAgY2xlYXJUaW1lb3V0KHRpbWVvdXQpOwogICAgfQogIH0KCiAgYXN5bmMgZnVuY3Rpb24gZmV0Y2hBbGwob3B0aW9ucyA9IHt9KSB7CiAgICBpZiAoc3RhdGUuaXNGZXRjaGluZykgcmV0dXJuOwogICAgc3RhdGUuaXNGZXRjaGluZyA9IHRydWU7CiAgICBzZXRMb2FkaW5nKE5VTUVSSUNfSURTLCB0cnVlKTsKICAgIHNldEZyZXNoQmFkZ2UoJ0FjdHVhbGl6YW5kb+KApicsICdmZXRjaGluZycpOwogICAgc2V0RXJyb3JCYW5uZXIoZmFsc2UpOwogICAgdHJ5IHsKICAgICAgY29uc3QgdGFza3MgPSBbCiAgICAgICAgWydtZXBDY2wnLCBFTkRQT0lOVFMubWVwQ2NsXQogICAgICBdOwoKICAgICAgY29uc3Qgc2V0dGxlZCA9IGF3YWl0IFByb21pc2UuYWxsU2V0dGxlZCh0YXNrcy5tYXAoYXN5bmMgKFtuYW1lLCB1cmxdKSA9PiB7CiAgICAgICAgdHJ5IHsKICAgICAgICAgIGNvbnN0IGRhdGEgPSBhd2FpdCBmZXRjaEpzb24odXJsKTsKICAgICAgICAgIHJldHVybiB7IG5hbWUsIGRhdGEgfTsKICAgICAgICB9IGNhdGNoIChlcnJvcikgewogICAgICAgICAgY29uc29sZS5lcnJvcihgW1JhZGFyTUVQXSBlcnJvciBlbiAke25hbWV9YCwgZXJyb3IpOwogICAgICAgICAgdGhyb3cgeyBuYW1lLCBlcnJvciB9OwogICAgICAgIH0KICAgICAgfSkpOwoKICAgICAgY29uc3QgYmFnID0geyB0aW1lc3RhbXA6IERhdGUubm93KCksIG1lcENjbDogbnVsbCB9OwogICAgICBjb25zdCBmYWlsZWQgPSBbXTsKICAgICAgc2V0dGxlZC5mb3JFYWNoKChyLCBpZHgpID0+IHsKICAgICAgICBjb25zdCBuYW1lID0gdGFza3NbaWR4XVswXTsKICAgICAgICBpZiAoci5zdGF0dXMgPT09ICdmdWxmaWxsZWQnKSBiYWdbbmFtZV0gPSByLnZhbHVlLmRhdGE7CiAgICAgICAgZWxzZSBmYWlsZWQucHVzaChuYW1lKTsKICAgICAgfSk7CgogICAgICByZW5kZXJNZXBDY2woYmFnLm1lcENjbCk7CiAgICAgIHN0YXRlLmxhc3RNZXBQYXlsb2FkID0gYmFnLm1lcENjbDsKICAgICAgcmVuZGVyTWV0cmljczI0aChiYWcubWVwQ2NsKTsKICAgICAgcmVuZGVyVHJlbmQoYmFnLm1lcENjbCk7CiAgICAgIHJlbmRlckhpc3RvcnkoYmFnLm1lcENjbCk7CiAgICAgIGNvbnN0IG1lcFJvb3QgPSBleHRyYWN0Um9vdChiYWcubWVwQ2NsKTsKICAgICAgY29uc3QgdXBkYXRlZEFydCA9IHR5cGVvZiBtZXBSb290Py51cGRhdGVkQXRIdW1hbkFydCA9PT0gJ3N0cmluZycgPyBtZXBSb290LnVwZGF0ZWRBdEh1bWFuQXJ0IDogbnVsbDsKICAgICAgY29uc3Qgc291cmNlVHNNcyA9IHRvTnVtYmVyKG1lcFJvb3Q/LnNvdXJjZVN0YXR1cz8ubGF0ZXN0U291cmNlVHNNcykKICAgICAgICA/PyB0b051bWJlcihtZXBSb290Py5jdXJyZW50Py5tZXBUc01zKQogICAgICAgID8/IHRvTnVtYmVyKG1lcFJvb3Q/LmN1cnJlbnQ/LmNjbFRzTXMpCiAgICAgICAgPz8gbnVsbDsKICAgICAgc3RhdGUuc291cmNlVHNNcyA9IHNvdXJjZVRzTXM7CiAgICAgIHNldFRleHQoJ2xhc3QtcnVuLXRpbWUnLCB1cGRhdGVkQXJ0IHx8IGZtdEFyZ1RpbWVTZWMuZm9ybWF0KG5ldyBEYXRlKCkpKTsKCiAgICAgIGNvbnN0IHN1Y2Nlc3NDb3VudCA9IHRhc2tzLmxlbmd0aCAtIGZhaWxlZC5sZW5ndGg7CiAgICAgIGlmIChzdWNjZXNzQ291bnQgPiAwKSB7CiAgICAgICAgc3RhdGUubGFzdFN1Y2Nlc3NBdCA9IERhdGUubm93KCk7CiAgICAgICAgc3RhdGUucmV0cnlJbmRleCA9IDA7CiAgICAgICAgaWYgKHN0YXRlLnJldHJ5VGltZXIpIGNsZWFyVGltZW91dChzdGF0ZS5yZXRyeVRpbWVyKTsKICAgICAgICBzYXZlQ2FjaGUoYmFnKTsKICAgICAgICBjb25zdCBhZ2VMYWJlbCA9IHNvdXJjZVRzTXMgIT0gbnVsbCA/IGZvcm1hdFNvdXJjZUFnZUxhYmVsKHNvdXJjZVRzTXMpIDogbnVsbDsKICAgICAgICBjb25zdCBiYWRnZUJhc2UgPSBhZ2VMYWJlbCA/IGDDmmx0aW1hIGFjdHVhbGl6YWNpw7NuIGhhY2U6ICR7YWdlTGFiZWx9YCA6IGBBY3R1YWxpemFkbyDCtyAke2ZtdEFyZ1RpbWUuZm9ybWF0KG5ldyBEYXRlKCkpfWA7CiAgICAgICAgaWYgKGZhaWxlZC5sZW5ndGgpIHNldEZyZXNoQmFkZ2UoYEFjdHVhbGl6YWNpw7NuIHBhcmNpYWwgwrcgJHtiYWRnZUJhc2V9YCwgJ2lkbGUnKTsKICAgICAgICBlbHNlIHNldEZyZXNoQmFkZ2UoYmFkZ2VCYXNlLCAnaWRsZScpOwogICAgICAgIHJlZnJlc2hGcmVzaEJhZGdlRnJvbVNvdXJjZSgpOwogICAgICB9IGVsc2UgewogICAgICAgIGNvbnN0IGF0dGVtcHQgPSBzdGF0ZS5yZXRyeUluZGV4ICsgMTsKICAgICAgICBpZiAoc3RhdGUucmV0cnlJbmRleCA8IFJFVFJZX0RFTEFZUy5sZW5ndGgpIHsKICAgICAgICAgIGNvbnN0IGRlbGF5ID0gUkVUUllfREVMQVlTW3N0YXRlLnJldHJ5SW5kZXhdOwogICAgICAgICAgc3RhdGUucmV0cnlJbmRleCArPSAxOwogICAgICAgICAgc2V0RnJlc2hCYWRnZShgRXJyb3IgwrcgUmVpbnRlbnRvIGVuICR7TWF0aC5yb3VuZChkZWxheSAvIDEwMDApfXNgLCAnZXJyb3InKTsKICAgICAgICAgIGlmIChzdGF0ZS5yZXRyeVRpbWVyKSBjbGVhclRpbWVvdXQoc3RhdGUucmV0cnlUaW1lcik7CiAgICAgICAgICBzdGF0ZS5yZXRyeVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBmZXRjaEFsbCh7IG1hbnVhbDogdHJ1ZSB9KSwgZGVsYXkpOwogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICBzZXRGcmVzaEJhZGdlKCdFcnJvciDCtyBSZWludGVudGFyJywgJ2Vycm9yJyk7CiAgICAgICAgICBzZXRFcnJvckJhbm5lcih0cnVlLCAnRXJyb3IgYWwgYWN0dWFsaXphciDCtyBSZWludGVudGFyJyk7CiAgICAgICAgICBjb25zb2xlLmVycm9yKGBbUmFkYXJNRVBdIHNlIGFnb3Rhcm9uIHJldHJpZXMgKCR7YXR0ZW1wdH0gaW50ZW50b3MpYCk7CiAgICAgICAgICBpZiAod2luZG93LnNjaGVkdWxlcikgd2luZG93LnNjaGVkdWxlci5zdG9wKCk7CiAgICAgICAgfQogICAgICB9CiAgICB9IGZpbmFsbHkgewogICAgICBzZXRMb2FkaW5nKE5VTUVSSUNfSURTLCBmYWxzZSk7CiAgICAgIHN0YXRlLmlzRmV0Y2hpbmcgPSBmYWxzZTsKICAgIH0KICB9CgogIC8vIDUpIENsYXNlIE1hcmtldFNjaGVkdWxlcgogIGNsYXNzIE1hcmtldFNjaGVkdWxlciB7CiAgICBjb25zdHJ1Y3RvcihmZXRjaEZuLCBpbnRlcnZhbE1zID0gMzAwMDAwKSB7CiAgICAgIHRoaXMuZmV0Y2hGbiA9IGZldGNoRm47CiAgICAgIHRoaXMuaW50ZXJ2YWxNcyA9IGludGVydmFsTXM7CiAgICAgIHRoaXMudGltZXIgPSBudWxsOwogICAgICB0aGlzLndhaXRUaW1lciA9IG51bGw7CiAgICAgIHRoaXMuY291bnRkb3duVGltZXIgPSBudWxsOwogICAgICB0aGlzLm5leHRSdW5BdCA9IG51bGw7CiAgICAgIHRoaXMucnVubmluZyA9IGZhbHNlOwogICAgICB0aGlzLnBhdXNlZCA9IGZhbHNlOwogICAgfQoKICAgIHN0YXJ0KCkgewogICAgICBpZiAodGhpcy5ydW5uaW5nKSByZXR1cm47CiAgICAgIHRoaXMucnVubmluZyA9IHRydWU7CiAgICAgIHRoaXMucGF1c2VkID0gZmFsc2U7CiAgICAgIGlmICh0aGlzLmlzTWFya2V0T3BlbigpKSB7CiAgICAgICAgc2V0TWFya2V0VGFnKHRydWUpOwogICAgICAgIHRoaXMuX3NjaGVkdWxlKHRoaXMuaW50ZXJ2YWxNcyk7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgc2V0TWFya2V0VGFnKGZhbHNlKTsKICAgICAgICB0aGlzLl93YWl0Rm9yT3BlbigpOwogICAgICB9CiAgICAgIHRoaXMuX3N0YXJ0Q291bnRkb3duKCk7CiAgICB9CgogICAgcGF1c2UoKSB7CiAgICAgIHRoaXMucGF1c2VkID0gdHJ1ZTsKICAgICAgY2xlYXJUaW1lb3V0KHRoaXMudGltZXIpOwogICAgICBjbGVhclRpbWVvdXQodGhpcy53YWl0VGltZXIpOwogICAgICB0aGlzLnRpbWVyID0gbnVsbDsKICAgICAgdGhpcy53YWl0VGltZXIgPSBudWxsOwogICAgICB0aGlzLl9zdG9wQ291bnRkb3duKCk7CiAgICAgIGNvbnN0IGNvdW50ZG93biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb3VudGRvd24tdGV4dCcpOwogICAgICBpZiAoY291bnRkb3duKSBjb3VudGRvd24udGV4dENvbnRlbnQgPSAnQWN0dWFsaXphY2nDs24gcGF1c2FkYSc7CiAgICB9CgogICAgcmVzdW1lKCkgewogICAgICBpZiAoIXRoaXMucnVubmluZykgdGhpcy5ydW5uaW5nID0gdHJ1ZTsKICAgICAgdGhpcy5wYXVzZWQgPSBmYWxzZTsKICAgICAgY29uc3QgY29udGludWVSZXN1bWUgPSAoKSA9PiB7CiAgICAgICAgaWYgKHRoaXMuaXNNYXJrZXRPcGVuKCkpIHsKICAgICAgICAgIHNldE1hcmtldFRhZyh0cnVlKTsKICAgICAgICAgIHRoaXMuX3NjaGVkdWxlKHRoaXMuaW50ZXJ2YWxNcyk7CiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgIHNldE1hcmtldFRhZyhmYWxzZSk7CiAgICAgICAgICB0aGlzLl93YWl0Rm9yT3BlbigpOwogICAgICAgIH0KICAgICAgICB0aGlzLl9zdGFydENvdW50ZG93bigpOwogICAgICB9OwogICAgICBpZiAoRGF0ZS5ub3coKSAtIHN0YXRlLmxhc3RTdWNjZXNzQXQgPiB0aGlzLmludGVydmFsTXMpIHsKICAgICAgICBQcm9taXNlLnJlc29sdmUodGhpcy5mZXRjaEZuKHsgbWFudWFsOiB0cnVlIH0pKS5maW5hbGx5KGNvbnRpbnVlUmVzdW1lKTsKICAgICAgfSBlbHNlIHsKICAgICAgICBjb250aW51ZVJlc3VtZSgpOwogICAgICB9CiAgICB9CgogICAgc3RvcCgpIHsKICAgICAgdGhpcy5ydW5uaW5nID0gZmFsc2U7CiAgICAgIHRoaXMucGF1c2VkID0gZmFsc2U7CiAgICAgIGNsZWFyVGltZW91dCh0aGlzLnRpbWVyKTsKICAgICAgY2xlYXJUaW1lb3V0KHRoaXMud2FpdFRpbWVyKTsKICAgICAgdGhpcy50aW1lciA9IG51bGw7CiAgICAgIHRoaXMud2FpdFRpbWVyID0gbnVsbDsKICAgICAgdGhpcy5uZXh0UnVuQXQgPSBudWxsOwogICAgICB0aGlzLl9zdG9wQ291bnRkb3duKCk7CiAgICB9CgogICAgaXNNYXJrZXRPcGVuKCkgewogICAgICBjb25zdCBwID0gZ2V0QXJnTm93UGFydHMoKTsKICAgICAgY29uc3QgYnVzaW5lc3NEYXkgPSBwLndlZWtkYXkgPj0gMSAmJiBwLndlZWtkYXkgPD0gNTsKICAgICAgY29uc3Qgc2Vjb25kcyA9IHAuaG91ciAqIDM2MDAgKyBwLm1pbnV0ZSAqIDYwICsgcC5zZWNvbmQ7CiAgICAgIGNvbnN0IGZyb20gPSAxMCAqIDM2MDAgKyAzMCAqIDYwOwogICAgICBjb25zdCB0byA9IDE4ICogMzYwMDsKICAgICAgcmV0dXJuIGJ1c2luZXNzRGF5ICYmIHNlY29uZHMgPj0gZnJvbSAmJiBzZWNvbmRzIDwgdG87CiAgICB9CgogICAgZ2V0TmV4dFJ1blRpbWUoKSB7CiAgICAgIHJldHVybiB0aGlzLm5leHRSdW5BdCA/IG5ldyBEYXRlKHRoaXMubmV4dFJ1bkF0KSA6IG51bGw7CiAgICB9CgogICAgX3NjaGVkdWxlKGRlbGF5TXMpIHsKICAgICAgaWYgKCF0aGlzLnJ1bm5pbmcgfHwgdGhpcy5wYXVzZWQpIHJldHVybjsKICAgICAgY2xlYXJUaW1lb3V0KHRoaXMudGltZXIpOwogICAgICB0aGlzLm5leHRSdW5BdCA9IERhdGUubm93KCkgKyBkZWxheU1zOwogICAgICB0aGlzLnRpbWVyID0gc2V0VGltZW91dChhc3luYyAoKSA9PiB7CiAgICAgICAgaWYgKCF0aGlzLnJ1bm5pbmcgfHwgdGhpcy5wYXVzZWQpIHJldHVybjsKICAgICAgICBpZiAoIXRoaXMuaXNNYXJrZXRPcGVuKCkpIHsKICAgICAgICAgIHNldE1hcmtldFRhZyhmYWxzZSk7CiAgICAgICAgICB0aGlzLl93YWl0Rm9yT3BlbigpOwogICAgICAgICAgcmV0dXJuOwogICAgICAgIH0KICAgICAgICBzZXRNYXJrZXRUYWcodHJ1ZSk7CiAgICAgICAgYXdhaXQgdGhpcy5mZXRjaEZuKCk7CiAgICAgICAgdGhpcy5fc2NoZWR1bGUodGhpcy5pbnRlcnZhbE1zKTsKICAgICAgfSwgZGVsYXlNcyk7CiAgICB9CgogICAgX3dhaXRGb3JPcGVuKCkgewogICAgICBpZiAoIXRoaXMucnVubmluZyB8fCB0aGlzLnBhdXNlZCkgcmV0dXJuOwogICAgICBjbGVhclRpbWVvdXQodGhpcy53YWl0VGltZXIpOwogICAgICB0aGlzLm5leHRSdW5BdCA9IERhdGUubm93KCkgKyA2MDAwMDsKICAgICAgdGhpcy53YWl0VGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHsKICAgICAgICBpZiAoIXRoaXMucnVubmluZyB8fCB0aGlzLnBhdXNlZCkgcmV0dXJuOwogICAgICAgIGlmICh0aGlzLmlzTWFya2V0T3BlbigpKSB7CiAgICAgICAgICBzZXRNYXJrZXRUYWcodHJ1ZSk7CiAgICAgICAgICB0aGlzLmZldGNoRm4oeyBtYW51YWw6IHRydWUgfSk7CiAgICAgICAgICB0aGlzLl9zY2hlZHVsZSh0aGlzLmludGVydmFsTXMpOwogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICBzZXRNYXJrZXRUYWcoZmFsc2UpOwogICAgICAgICAgdGhpcy5fd2FpdEZvck9wZW4oKTsKICAgICAgICB9CiAgICAgIH0sIDYwMDAwKTsKICAgIH0KCiAgICBfc3RhcnRDb3VudGRvd24oKSB7CiAgICAgIHRoaXMuX3N0b3BDb3VudGRvd24oKTsKICAgICAgdGhpcy5jb3VudGRvd25UaW1lciA9IHNldEludGVydmFsKCgpID0+IHsKICAgICAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb3VudGRvd24tdGV4dCcpOwogICAgICAgIGlmICghZWwgfHwgdGhpcy5wYXVzZWQpIHJldHVybjsKICAgICAgICBjb25zdCBuZXh0ID0gdGhpcy5nZXROZXh0UnVuVGltZSgpOwogICAgICAgIGlmICghbmV4dCkgewogICAgICAgICAgZWwudGV4dENvbnRlbnQgPSB0aGlzLmlzTWFya2V0T3BlbigpID8gJ1Byw7N4aW1hIGFjdHVhbGl6YWNpw7NuIGVuIOKAlCcgOiAnTWVyY2FkbyBjZXJyYWRvJzsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgICAgY29uc3QgZGlmZiA9IE1hdGgubWF4KDAsIG5leHQuZ2V0VGltZSgpIC0gRGF0ZS5ub3coKSk7CiAgICAgICAgY29uc3QgbSA9IE1hdGguZmxvb3IoZGlmZiAvIDYwMDAwKTsKICAgICAgICBjb25zdCBzID0gTWF0aC5mbG9vcigoZGlmZiAlIDYwMDAwKSAvIDEwMDApOwogICAgICAgIGlmICh0aGlzLmlzTWFya2V0T3BlbigpKSBlbC50ZXh0Q29udGVudCA9IGBQcsOzeGltYSBhY3R1YWxpemFjacOzbiBlbiAke219OiR7U3RyaW5nKHMpLnBhZFN0YXJ0KDIsICcwJyl9YDsKICAgICAgICBlbHNlIGVsLnRleHRDb250ZW50ID0gJ01lcmNhZG8gY2VycmFkbyc7CiAgICAgIH0sIDEwMDApOwogICAgfQoKICAgIF9zdG9wQ291bnRkb3duKCkgewogICAgICBjbGVhckludGVydmFsKHRoaXMuY291bnRkb3duVGltZXIpOwogICAgICB0aGlzLmNvdW50ZG93blRpbWVyID0gbnVsbDsKICAgIH0KICB9CgogIC8vIDYpIEzDs2dpY2EgZGUgY2FjaMOpCiAgZnVuY3Rpb24gc2F2ZUNhY2hlKGRhdGEpIHsKICAgIHRyeSB7CiAgICAgIHNlc3Npb25TdG9yYWdlLnNldEl0ZW0oQ0FDSEVfS0VZLCBKU09OLnN0cmluZ2lmeSh7CiAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLAogICAgICAgIG1lcENjbDogZGF0YS5tZXBDY2wKICAgICAgfSkpOwogICAgfSBjYXRjaCAoZSkgewogICAgICBjb25zb2xlLmVycm9yKCdbUmFkYXJNRVBdIG5vIHNlIHB1ZG8gZ3VhcmRhciBjYWNoZScsIGUpOwogICAgfQogIH0KCiAgZnVuY3Rpb24gbG9hZENhY2hlKCkgewogICAgdHJ5IHsKICAgICAgY29uc3QgcmF3ID0gc2Vzc2lvblN0b3JhZ2UuZ2V0SXRlbShDQUNIRV9LRVkpOwogICAgICBpZiAoIXJhdykgcmV0dXJuIG51bGw7CiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KTsKICAgICAgaWYgKCFwYXJzZWQudGltZXN0YW1wIHx8IERhdGUubm93KCkgLSBwYXJzZWQudGltZXN0YW1wID4gQ0FDSEVfVFRMX01TKSByZXR1cm4gbnVsbDsKICAgICAgcmV0dXJuIHBhcnNlZDsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgY29uc29sZS5lcnJvcignW1JhZGFyTUVQXSBjYWNoZSBpbnbDoWxpZGEnLCBlKTsKICAgICAgcmV0dXJuIG51bGw7CiAgICB9CiAgfQoKICAvLyA3KSBJbmljaWFsaXphY2nDs24KICBzdGFydEZyZXNoVGlja2VyKCk7CiAgZnVuY3Rpb24gdG9nZ2xlRHJhd2VyKCkgewogICAgY29uc3QgZHJhd2VyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2RyYXdlcicpOwogICAgY29uc3Qgd3JhcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdib2R5V3JhcCcpOwogICAgY29uc3QgYnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2J0blRhc2FzJyk7CiAgICBjb25zdCBvdmwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnb3ZlcmxheScpOwogICAgY29uc3QgaXNPcGVuID0gZHJhd2VyLmNsYXNzTGlzdC5jb250YWlucygnb3BlbicpOwogICAgZHJhd2VyLmNsYXNzTGlzdC50b2dnbGUoJ29wZW4nLCAhaXNPcGVuKTsKICAgIHdyYXAuY2xhc3NMaXN0LnRvZ2dsZSgnZHJhd2VyLW9wZW4nLCAhaXNPcGVuKTsKICAgIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKCdhY3RpdmUnLCAhaXNPcGVuKTsKICAgIG92bC5jbGFzc0xpc3QudG9nZ2xlKCdzaG93JywgIWlzT3Blbik7CiAgfQoKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcucGlsbFtkYXRhLWZpbHRlcl0nKS5mb3JFYWNoKChwKSA9PiB7CiAgICBwLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gYXBwbHlGaWx0ZXIocC5kYXRhc2V0LmZpbHRlcikpOwogIH0pOwoKICBmdW5jdGlvbiB0b2dnbGVHbG9zKCkgewogICAgY29uc3QgZ3JpZCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdnbG9zR3JpZCcpOwogICAgY29uc3QgYXJyb3cgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZ2xvc0Fycm93Jyk7CiAgICBjb25zdCBvcGVuID0gZ3JpZC5jbGFzc0xpc3QudG9nZ2xlKCdvcGVuJyk7CiAgICBhcnJvdy50ZXh0Q29udGVudCA9IG9wZW4gPyAn4pa0JyA6ICfilr4nOwogIH0KCiAgY29uc3QgcmV0cnlCdG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZXJyb3ItcmV0cnktYnRuJyk7CiAgaWYgKHJldHJ5QnRuKSB7CiAgICByZXRyeUJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgaWYgKHdpbmRvdy5zY2hlZHVsZXIpIHdpbmRvdy5zY2hlZHVsZXIucmVzdW1lKCk7CiAgICAgIGZldGNoQWxsKHsgbWFudWFsOiB0cnVlIH0pOwogICAgfSk7CiAgfQoKICBjb25zdCBjYWNoZWQgPSBsb2FkQ2FjaGUoKTsKICBpbml0SGlzdG9yeUNvbHVtbldpZHRocygpOwogIGJpbmRIaXN0b3J5Q29sdW1uUmVzaXplKCk7CiAgaWYgKGNhY2hlZCkgewogICAgc3RhdGUubGFzdE1lcFBheWxvYWQgPSBjYWNoZWQubWVwQ2NsOwogICAgcmVuZGVyTWVwQ2NsKGNhY2hlZC5tZXBDY2wpOwogICAgcmVuZGVyTWV0cmljczI0aChjYWNoZWQubWVwQ2NsKTsKICAgIHJlbmRlclRyZW5kKGNhY2hlZC5tZXBDY2wpOwogICAgcmVuZGVySGlzdG9yeShjYWNoZWQubWVwQ2NsKTsKICAgIGNvbnN0IGNhY2hlZFJvb3QgPSBleHRyYWN0Um9vdChjYWNoZWQubWVwQ2NsKTsKICAgIHN0YXRlLnNvdXJjZVRzTXMgPSB0b051bWJlcihjYWNoZWRSb290Py5zb3VyY2VTdGF0dXM/LmxhdGVzdFNvdXJjZVRzTXMpCiAgICAgID8/IHRvTnVtYmVyKGNhY2hlZFJvb3Q/LmN1cnJlbnQ/Lm1lcFRzTXMpCiAgICAgID8/IHRvTnVtYmVyKGNhY2hlZFJvb3Q/LmN1cnJlbnQ/LmNjbFRzTXMpCiAgICAgID8/IG51bGw7CiAgICByZWZyZXNoRnJlc2hCYWRnZUZyb21Tb3VyY2UoKTsKICB9CgogIGFwcGx5RmlsdGVyKHN0YXRlLmZpbHRlck1vZGUpOwoKICB3aW5kb3cuc2NoZWR1bGVyID0gbmV3IE1hcmtldFNjaGVkdWxlcihmZXRjaEFsbCwgRkVUQ0hfSU5URVJWQUxfTVMpOwogIHdpbmRvdy5zY2hlZHVsZXIuc3RhcnQoKTsKICBmZXRjaEFsbCh7IG1hbnVhbDogdHJ1ZSB9KTsKCiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcigndmlzaWJpbGl0eWNoYW5nZScsICgpID0+IHsKICAgIGlmIChkb2N1bWVudC5oaWRkZW4pIHdpbmRvdy5zY2hlZHVsZXIucGF1c2UoKTsKICAgIGVsc2Ugd2luZG93LnNjaGVkdWxlci5yZXN1bWUoKTsKICB9KTsKPC9zY3JpcHQ+CjwvYm9keT4KPC9odG1sPgo=`;

function decodeBase64Utf8(b64) {
  const compact = b64.replace(/\s+/g, "");
  const binary = atob(compact);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function renderDashboardHtml() {
  return decodeBase64Utf8(DASHBOARD_HTML_B64);
}
