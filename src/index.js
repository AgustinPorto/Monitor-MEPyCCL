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

const DASHBOARD_HTML_B64 = `PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVzIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAiPgo8dGl0bGU+UmFkYXIgTUVQL0NDTCDCtyBNZXJjYWRvIEFSRzwvdGl0bGU+CjxsaW5rIHJlbD0icHJlY29ubmVjdCIgaHJlZj0iaHR0cHM6Ly9mb250cy5nb29nbGVhcGlzLmNvbSI+CjxsaW5rIGhyZWY9Imh0dHBzOi8vZm9udHMuZ29vZ2xlYXBpcy5jb20vY3NzMj9mYW1pbHk9U3BhY2UrTW9ubzp3Z2h0QDQwMDs3MDAmZmFtaWx5PVN5bmU6d2dodEA0MDA7NjAwOzcwMDs4MDAmZGlzcGxheT1zd2FwIiByZWw9InN0eWxlc2hlZXQiPgo8c3R5bGU+Ci8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBUT0tFTlMK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCjpyb290IHsKICAtLWJnOiAgICAgICAjMDgwYjBlOwogIC0tc3VyZjogICAgICMwZjEzMTg7CiAgLS1zdXJmMjogICAgIzE2MWIyMjsKICAtLXN1cmYzOiAgICAjMWMyMzMwOwogIC0tYm9yZGVyOiAgICMxZTI1MzA7CiAgLS1ib3JkZXJCOiAgIzJhMzQ0NDsKCiAgLS1ncmVlbjogICAgIzAwZTY3NjsKICAtLWdyZWVuLWQ6ICByZ2JhKDAsMjMwLDExOCwuMDkpOwogIC0tZ3JlZW4tZzogIHJnYmEoMCwyMzAsMTE4LC4yMik7CiAgLS1yZWQ6ICAgICAgI2ZmNDc1NzsKICAtLXJlZC1kOiAgICByZ2JhKDI1NSw3MSw4NywuMDkpOwogIC0teWVsbG93OiAgICNmZmMgYzAwOwogIC0teWVsbG93OiAgICNmZmNjMDA7CiAgLS15ZWxsb3ctZDogcmdiYSgyNTUsMjA0LDAsLjA5KTsKCiAgLS1tZXA6ICAgICAgIzI5YjZmNjsKICAtLWNjbDogICAgICAjYjM5ZGRiOwogIC0tdGV4dDogICAgICNkZGU0ZWU7CiAgLS1tdXRlZDogICAgIzU1NjA3MDsKICAtLW11dGVkMjogICAjN2E4ZmE4OwoKICAtLW1vbm86ICdTcGFjZSBNb25vJywgbW9ub3NwYWNlOwogIC0tc2FuczogJ1N5bmUnLCBzYW5zLXNlcmlmOwoKICAtLWRyYXdlci13OiA0MDBweDsKICAtLWhlYWRlci1oOiA1NHB4Owp9CgoqLCAqOjpiZWZvcmUsICo6OmFmdGVyIHsgYm94LXNpemluZzogYm9yZGVyLWJveDsgbWFyZ2luOiAwOyBwYWRkaW5nOiAwOyB9CgpodG1sIHsgc2Nyb2xsLWJlaGF2aW9yOiBzbW9vdGg7IH0KCmJvZHkgewogIGJhY2tncm91bmQ6IHZhcigtLWJnKTsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgZm9udC1mYW1pbHk6IHZhcigtLW1vbm8pOwogIG1pbi1oZWlnaHQ6IDEwMHZoOwogIG92ZXJmbG93LXg6IGhpZGRlbjsKfQoKYm9keTo6YmVmb3JlIHsKICBjb250ZW50OiAnJzsKICBwb3NpdGlvbjogZml4ZWQ7IGluc2V0OiAwOwogIGJhY2tncm91bmQtaW1hZ2U6CiAgICBsaW5lYXItZ3JhZGllbnQocmdiYSg0MSwxODIsMjQ2LC4wMjUpIDFweCwgdHJhbnNwYXJlbnQgMXB4KSwKICAgIGxpbmVhci1ncmFkaWVudCg5MGRlZywgcmdiYSg0MSwxODIsMjQ2LC4wMjUpIDFweCwgdHJhbnNwYXJlbnQgMXB4KTsKICBiYWNrZ3JvdW5kLXNpemU6IDQ0cHggNDRweDsKICBwb2ludGVyLWV2ZW50czogbm9uZTsgei1pbmRleDogMDsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIExBWU9VVCBTSEVMTArilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLmFwcCB7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBtaW4taGVpZ2h0OiAxMDB2aDsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIEhFQURFUgrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KaGVhZGVyIHsKICBwb3NpdGlvbjogc3RpY2t5OyB0b3A6IDA7IHotaW5kZXg6IDIwMDsKICBoZWlnaHQ6IHZhcigtLWhlYWRlci1oKTsKICBiYWNrZ3JvdW5kOiByZ2JhKDgsMTEsMTQsLjkzKTsKICBiYWNrZHJvcC1maWx0ZXI6IGJsdXIoMThweCk7CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgcGFkZGluZzogMCAyMnB4OwogIGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsKfQoKLmxvZ28gewogIGZvbnQtZmFtaWx5OiB2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6IDgwMDsgZm9udC1zaXplOiAxNXB4OwogIGxldHRlci1zcGFjaW5nOiAuMDVlbTsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA5cHg7Cn0KCi5saXZlLWRvdCB7CiAgd2lkdGg6IDdweDsgaGVpZ2h0OiA3cHg7IGJvcmRlci1yYWRpdXM6IDUwJTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1ncmVlbik7CiAgYm94LXNoYWRvdzogMCAwIDhweCB2YXIoLS1ncmVlbik7CiAgYW5pbWF0aW9uOiBibGluayAyLjJzIGVhc2UtaW4tb3V0IGluZmluaXRlOwp9CkBrZXlmcmFtZXMgYmxpbmsgewogIDAlLDEwMCV7b3BhY2l0eToxO2JveC1zaGFkb3c6MCAwIDhweCB2YXIoLS1ncmVlbik7fQogIDUwJXtvcGFjaXR5Oi4zNTtib3gtc2hhZG93OjAgMCAzcHggdmFyKC0tZ3JlZW4pO30KfQoKLmhlYWRlci1yaWdodCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMTJweDsgfQoKLmZyZXNoLWJhZGdlIHsKICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDVweDsKICBmb250LXNpemU6IDExcHg7IGNvbG9yOiB2YXIoLS1tdXRlZDIpOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYyKTsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOiAyMHB4OyBwYWRkaW5nOiAzcHggMTFweDsKfQouZnJlc2gtZG90IHsgd2lkdGg6NXB4O2hlaWdodDo1cHg7Ym9yZGVyLXJhZGl1czo1MCU7YmFja2dyb3VuZDp2YXIoLS1ncmVlbik7YW5pbWF0aW9uOmJsaW5rIDIuMnMgZWFzZS1pbi1vdXQgaW5maW5pdGU7IH0KLmZyZXNoLWJhZGdlLmZldGNoaW5nIHsgYW5pbWF0aW9uOiBiYWRnZVB1bHNlIDEuMnMgZWFzZS1pbi1vdXQgaW5maW5pdGU7IH0KLmZyZXNoLWJhZGdlLmVycm9yIHsgY29sb3I6I2ZmZDBkMDsgYm9yZGVyLWNvbG9yOnJnYmEoMjU1LDgyLDgyLC40NSk7IGJhY2tncm91bmQ6cmdiYSgyNTUsODIsODIsLjEyKTsgY3Vyc29yOnBvaW50ZXI7IH0KQGtleWZyYW1lcyBiYWRnZVB1bHNlIHsKICAwJSwxMDAlIHsgb3BhY2l0eToxOyB9CiAgNTAlIHsgb3BhY2l0eTouNjU7IH0KfQoKLnRhZy1tZXJjYWRvIHsKICBmb250LWZhbWlseTogdmFyKC0tc2Fucyk7IGZvbnQtc2l6ZToxMHB4OyBmb250LXdlaWdodDo3MDA7CiAgbGV0dGVyLXNwYWNpbmc6LjA4ZW07IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsKICBiYWNrZ3JvdW5kOnZhcigtLWdyZWVuKTsgY29sb3I6IzAwMDsKICBwYWRkaW5nOjNweCA5cHg7IGJvcmRlci1yYWRpdXM6NHB4Owp9Ci50YWctbWVyY2Fkby5jbG9zZWQgeyBiYWNrZ3JvdW5kOnZhcigtLW11dGVkKTsgY29sb3I6IzBhMGMwZjsgfQoKLmJ0biB7CiAgZm9udC1mYW1pbHk6IHZhcigtLXNhbnMpOyBmb250LXNpemU6MTFweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4wN2VtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7CiAgYm9yZGVyLXJhZGl1czo2cHg7IHBhZGRpbmc6NnB4IDE0cHg7IGN1cnNvcjpwb2ludGVyOwogIGJvcmRlcjpub25lOyB0cmFuc2l0aW9uOiBhbGwgLjE4czsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo2cHg7Cn0KLmJ0bi1hbGVydCB7IGJhY2tncm91bmQ6dmFyKC0tZ3JlZW4pOyBjb2xvcjojMDAwOyB9Ci5idG4tYWxlcnQ6aG92ZXIgeyBiYWNrZ3JvdW5kOiMwMGZmODg7IHRyYW5zZm9ybTp0cmFuc2xhdGVZKC0xcHgpOyB9CgouYnRuLXRhc2FzIHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMik7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyQik7CiAgY29sb3I6IHZhcigtLXRleHQpOwp9Ci5idG4tdGFzYXM6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMyk7IGJvcmRlci1jb2xvcjogdmFyKC0tbXV0ZWQyKTsgfQouYnRuLXRhc2FzLmFjdGl2ZSB7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZjMpOwogIGJvcmRlci1jb2xvcjogdmFyKC0teWVsbG93KTsKICBjb2xvcjogdmFyKC0teWVsbG93KTsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIE1BSU4gKyBEUkFXRVIgTEFZT1VUCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwouYm9keS13cmFwIHsKICBmbGV4OiAxOwogIGRpc3BsYXk6IGZsZXg7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIHotaW5kZXg6IDE7CiAgdHJhbnNpdGlvbjogbm9uZTsKfQoKLm1haW4tY29udGVudCB7CiAgZmxleDogMTsKICBtYXgtd2lkdGg6IDEwMCU7CiAgcGFkZGluZzogMjJweCAyMnB4IDYwcHg7CiAgdHJhbnNpdGlvbjogbWFyZ2luLXJpZ2h0IC4zNXMgY3ViaWMtYmV6aWVyKC40LDAsLjIsMSk7Cn0KCi5ib2R5LXdyYXAuZHJhd2VyLW9wZW4gLm1haW4tY29udGVudCB7CiAgbWFyZ2luLXJpZ2h0OiB2YXIoLS1kcmF3ZXItdyk7Cn0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBEUkFXRVIK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5kcmF3ZXIgewogIHBvc2l0aW9uOiBmaXhlZDsKICB0b3A6IHZhcigtLWhlYWRlci1oKTsKICByaWdodDogMDsKICB3aWR0aDogdmFyKC0tZHJhd2VyLXcpOwogIGhlaWdodDogY2FsYygxMDB2aCAtIHZhcigtLWhlYWRlci1oKSk7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZik7CiAgYm9yZGVyLWxlZnQ6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIHRyYW5zZm9ybTogdHJhbnNsYXRlWCgxMDAlKTsKICB0cmFuc2l0aW9uOiB0cmFuc2Zvcm0gLjM1cyBjdWJpYy1iZXppZXIoLjQsMCwuMiwxKTsKICBvdmVyZmxvdy15OiBhdXRvOwogIHotaW5kZXg6IDE1MDsKICBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwp9CgouZHJhd2VyLm9wZW4geyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVgoMCk7IH0KCi5kcmF3ZXItaGVhZGVyIHsKICBwb3NpdGlvbjogc3RpY2t5OyB0b3A6IDA7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZik7CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgcGFkZGluZzogMTZweCAyMHB4OwogIGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsKICB6LWluZGV4OiAxMDsKfQoKLmRyYXdlci10aXRsZSB7CiAgZm9udC1mYW1pbHk6IHZhcigtLXNhbnMpOyBmb250LXdlaWdodDogODAwOyBmb250LXNpemU6IDEzcHg7CiAgbGV0dGVyLXNwYWNpbmc6LjA0ZW07IGNvbG9yOiB2YXIoLS10ZXh0KTsKICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo4cHg7Cn0KCi5kcmF3ZXItc291cmNlIHsKICBmb250LXNpemU6MTBweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBmb250LWZhbWlseTp2YXIoLS1tb25vKTsKfQoKLmJ0bi1jbG9zZSB7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmMik7IGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBjb2xvcjp2YXIoLS1tdXRlZDIpOyBib3JkZXItcmFkaXVzOjZweDsgcGFkZGluZzo1cHggMTBweDsKICBjdXJzb3I6cG9pbnRlcjsgZm9udC1zaXplOjEzcHg7IHRyYW5zaXRpb246IGFsbCAuMTVzOwp9Ci5idG4tY2xvc2U6aG92ZXIgeyBjb2xvcjp2YXIoLS10ZXh0KTsgYm9yZGVyLWNvbG9yOnZhcigtLW11dGVkMik7IH0KCi5kcmF3ZXItYm9keSB7IHBhZGRpbmc6IDE2cHggMjBweDsgZGlzcGxheTogZmxleDsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgZ2FwOiAyMnB4OyB9CgouY29udGV4dC1ib3ggewogIGJhY2tncm91bmQ6IHJnYmEoMjU1LDIwNCwwLC4wNik7CiAgYm9yZGVyOiAxcHggc29saWQgcmdiYSgyNTUsMjA0LDAsLjIpOwogIGJvcmRlci1yYWRpdXM6IDlweDsKICBwYWRkaW5nOiAxM3B4IDE1cHg7CiAgZm9udC1zaXplOiAxMXB4OwogIGxpbmUtaGVpZ2h0OjEuNjU7CiAgY29sb3I6dmFyKC0tbXV0ZWQyKTsKfQouY29udGV4dC1ib3ggc3Ryb25nIHsgY29sb3I6dmFyKC0teWVsbG93KTsgfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIFNUQVRVUyBCQU5ORVIK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5zdGF0dXMtYmFubmVyIHsKICBib3JkZXItcmFkaXVzOjExcHg7IHBhZGRpbmc6MThweCAyNHB4OyBtYXJnaW4tYm90dG9tOjIwcHg7CiAgYm9yZGVyOjFweCBzb2xpZDsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47CiAgYW5pbWF0aW9uOmZhZGVJbiAuNHMgZWFzZTsKICBvdmVyZmxvdzpoaWRkZW47IHBvc2l0aW9uOnJlbGF0aXZlOwp9Ci5zdGF0dXMtYmFubmVyLnNpbWlsYXIgewogIGJhY2tncm91bmQ6dmFyKC0tZ3JlZW4tZCk7IGJvcmRlci1jb2xvcjpyZ2JhKDAsMjMwLDExOCwuMjgpOwp9Ci5zdGF0dXMtYmFubmVyLnNpbWlsYXI6OmFmdGVyIHsKICBjb250ZW50OicnOyBwb3NpdGlvbjphYnNvbHV0ZTsgcmlnaHQ6LTUwcHg7IHRvcDo1MCU7CiAgdHJhbnNmb3JtOnRyYW5zbGF0ZVkoLTUwJSk7IHdpZHRoOjIwMHB4OyBoZWlnaHQ6MjAwcHg7CiAgYm9yZGVyLXJhZGl1czo1MCU7CiAgYmFja2dyb3VuZDpyYWRpYWwtZ3JhZGllbnQoY2lyY2xlLHZhcigtLWdyZWVuLWcpIDAlLHRyYW5zcGFyZW50IDcwJSk7CiAgcG9pbnRlci1ldmVudHM6bm9uZTsKfQouc3RhdHVzLWJhbm5lci5uby1zaW1pbGFyIHsKICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSw4Miw4MiwuMDgpOwogIGJvcmRlci1jb2xvcjogcmdiYSgyNTUsODIsODIsLjM1KTsKfQouc3RhdHVzLWJhbm5lci5uby1zaW1pbGFyOjphZnRlciB7CiAgY29udGVudDonJzsKICBwb3NpdGlvbjphYnNvbHV0ZTsKICByaWdodDotNTBweDsKICB0b3A6NTAlOwogIHRyYW5zZm9ybTp0cmFuc2xhdGVZKC01MCUpOwogIHdpZHRoOjIwMHB4OwogIGhlaWdodDoyMDBweDsKICBib3JkZXItcmFkaXVzOjUwJTsKICBiYWNrZ3JvdW5kOnJhZGlhbC1ncmFkaWVudChjaXJjbGUscmdiYSgyNTUsODIsODIsLjE4KSAwJSx0cmFuc3BhcmVudCA3MCUpOwogIHBvaW50ZXItZXZlbnRzOm5vbmU7Cn0KCi5zLWxlZnQge30KLnMtdGl0bGUgewogIGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXdlaWdodDo4MDA7IGZvbnQtc2l6ZToyNnB4OwogIGxldHRlci1zcGFjaW5nOi0uMDJlbTsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDoxMnB4Owp9Ci5zLWJhZGdlIHsKICBmb250LXNpemU6MTBweDsgZm9udC13ZWlnaHQ6NzAwOyBsZXR0ZXItc3BhY2luZzouMWVtOwogIHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsgcGFkZGluZzoycHggOXB4OyBib3JkZXItcmFkaXVzOjRweDsKICBiYWNrZ3JvdW5kOnZhcigtLWdyZWVuKTsgY29sb3I6IzAwMDsgYWxpZ24tc2VsZjpjZW50ZXI7Cn0KLnMtYmFkZ2Uubm9zaW0geyBiYWNrZ3JvdW5kOiB2YXIoLS1yZWQpOyBjb2xvcjogI2ZmZjsgfQoucy1zdWIgeyBmb250LXNpemU6MTFweDsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgbWFyZ2luLXRvcDo0cHg7IH0KCi5lcnJvci1iYW5uZXIgewogIGRpc3BsYXk6bm9uZTsKICBtYXJnaW46IDAgMCAxNHB4IDA7CiAgcGFkZGluZzogMTBweCAxMnB4OwogIGJvcmRlci1yYWRpdXM6IDhweDsKICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDI1NSw4Miw4MiwuNDUpOwogIGJhY2tncm91bmQ6IHJnYmEoMjU1LDgyLDgyLC4xMik7CiAgY29sb3I6ICNmZmQwZDA7CiAgZm9udC1zaXplOiAxMXB4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuOwogIGdhcDogMTBweDsKfQouZXJyb3ItYmFubmVyLnNob3cgeyBkaXNwbGF5OmZsZXg7IH0KLmVycm9yLWJhbm5lciBidXR0b24gewogIGJvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsODIsODIsLjUpOwogIGJhY2tncm91bmQ6IHJnYmEoMjU1LDgyLDgyLC4xNSk7CiAgY29sb3I6I2ZmZGVkZTsKICBib3JkZXItcmFkaXVzOjZweDsKICBwYWRkaW5nOjRweCAxMHB4OwogIGZvbnQtc2l6ZToxMHB4OwogIGZvbnQtd2VpZ2h0OjcwMDsKICB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7CiAgbGV0dGVyLXNwYWNpbmc6LjA2ZW07CiAgY3Vyc29yOnBvaW50ZXI7Cn0KCi5za2VsZXRvbiB7CiAgYmFja2dyb3VuZDogbGluZWFyLWdyYWRpZW50KDkwZGVnLCAjMWMyMzMwIDI1JSwgIzJhMzQ0NCA1MCUsICMxYzIzMzAgNzUlKTsKICBiYWNrZ3JvdW5kLXNpemU6IDIwMCUgMTAwJTsKICBhbmltYXRpb246IHNoaW1tZXIgMS40cyBpbmZpbml0ZTsKICBib3JkZXItcmFkaXVzOiA0cHg7CiAgY29sb3I6IHRyYW5zcGFyZW50OwogIHVzZXItc2VsZWN0OiBub25lOwp9CkBrZXlmcmFtZXMgc2hpbW1lciB7CiAgMCUgICB7IGJhY2tncm91bmQtcG9zaXRpb246IDIwMCUgMDsgfQogIDEwMCUgeyBiYWNrZ3JvdW5kLXBvc2l0aW9uOiAtMjAwJSAwOyB9Cn0KCi52YWx1ZS1jaGFuZ2VkIHsKICBhbmltYXRpb246IGZsYXNoVmFsdWUgNjAwbXMgZWFzZTsKfQpAa2V5ZnJhbWVzIGZsYXNoVmFsdWUgewogIDAlICAgeyBjb2xvcjogI2ZmY2MwMDsgfQogIDEwMCUgeyBjb2xvcjogaW5oZXJpdDsgfQp9Cgoucy1yaWdodCB7IHRleHQtYWxpZ246cmlnaHQ7IGZvbnQtc2l6ZToxMXB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7IGxpbmUtaGVpZ2h0OjEuOTsgfQoucy1yaWdodCBzdHJvbmcgeyBjb2xvcjp2YXIoLS1tdXRlZDIpOyB9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgSEVSTyBDQVJEUwrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLmhlcm8tZ3JpZCB7CiAgZGlzcGxheTpncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmciAxZnI7CiAgZ2FwOjE0cHg7IG1hcmdpbi1ib3R0b206MjBweDsKfQoKLmhjYXJkIHsKICBiYWNrZ3JvdW5kOnZhcigtLXN1cmYpOyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czoxMXB4OyBwYWRkaW5nOjIwcHggMjJweDsKICBwb3NpdGlvbjpyZWxhdGl2ZTsgb3ZlcmZsb3c6aGlkZGVuOwogIHRyYW5zaXRpb246Ym9yZGVyLWNvbG9yIC4xOHM7CiAgYW5pbWF0aW9uOiBmYWRlVXAgLjVzIGVhc2UgYm90aDsKfQouaGNhcmQ6bnRoLWNoaWxkKDEpe2FuaW1hdGlvbi1kZWxheTouMDhzO30KLmhjYXJkOm50aC1jaGlsZCgyKXthbmltYXRpb24tZGVsYXk6LjE2czt9Ci5oY2FyZDpudGgtY2hpbGQoMyl7YW5pbWF0aW9uLWRlbGF5Oi4yNHM7fQouaGNhcmQ6aG92ZXIgeyBib3JkZXItY29sb3I6dmFyKC0tYm9yZGVyQik7IH0KCi5oY2FyZCAuYmFyIHsgcG9zaXRpb246YWJzb2x1dGU7IHRvcDowO2xlZnQ6MDtyaWdodDowOyBoZWlnaHQ6MnB4OyB9Ci5oY2FyZC5tZXAgLmJhciB7IGJhY2tncm91bmQ6dmFyKC0tbWVwKTsgfQouaGNhcmQuY2NsIC5iYXIgeyBiYWNrZ3JvdW5kOnZhcigtLWNjbCk7IH0KLmhjYXJkLmdhcCAuYmFyIHsgYmFja2dyb3VuZDp2YXIoLS15ZWxsb3cpOyB9CgouaGNhcmQtbGFiZWwgewogIGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXNpemU6MTBweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4xMmVtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7IGNvbG9yOnZhcigtLW11dGVkKTsKICBtYXJnaW4tYm90dG9tOjlweDsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo1cHg7Cn0KLmhjYXJkLWxhYmVsIC5kb3QgeyB3aWR0aDo1cHg7aGVpZ2h0OjVweDtib3JkZXItcmFkaXVzOjUwJTsgfQoubWVwIC5kb3R7YmFja2dyb3VuZDp2YXIoLS1tZXApO30KLmNjbCAuZG90e2JhY2tncm91bmQ6dmFyKC0tY2NsKTt9Ci5nYXAgLmRvdHtiYWNrZ3JvdW5kOnZhcigtLXllbGxvdyk7fQoKLmhjYXJkLXZhbCB7CiAgZm9udC1zaXplOjM0cHg7IGZvbnQtd2VpZ2h0OjcwMDsgbGV0dGVyLXNwYWNpbmc6LS4wMmVtOyBsaW5lLWhlaWdodDoxOwp9Ci5tZXAgLmhjYXJkLXZhbHtjb2xvcjp2YXIoLS1tZXApO30KLmNjbCAuaGNhcmQtdmFse2NvbG9yOnZhcigtLWNjbCk7fQoKLmhjYXJkLXBjdCB7IGZvbnQtc2l6ZToyMHB4OyBjb2xvcjp2YXIoLS15ZWxsb3cpOyBmb250LXdlaWdodDo3MDA7IG1hcmdpbi10b3A6M3B4OyB9Ci5oY2FyZC1zdWIgeyBmb250LXNpemU6MTBweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBtYXJnaW4tdG9wOjdweDsgfQoKLyogdG9vbHRpcCAqLwoudGlwIHsgcG9zaXRpb246cmVsYXRpdmU7IGN1cnNvcjpoZWxwOyB9Ci50aXA6OmFmdGVyIHsKICBjb250ZW50OmF0dHIoZGF0YS10KTsKICBwb3NpdGlvbjphYnNvbHV0ZTsgYm90dG9tOmNhbGMoMTAwJSArIDdweCk7IGxlZnQ6NTAlOwogIHRyYW5zZm9ybTp0cmFuc2xhdGVYKC01MCUpOwogIGJhY2tncm91bmQ6IzFhMjIzMjsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXJCKTsKICBjb2xvcjp2YXIoLS10ZXh0KTsgZm9udC1zaXplOjEwcHg7IHBhZGRpbmc6NXB4IDlweDsKICBib3JkZXItcmFkaXVzOjZweDsgd2hpdGUtc3BhY2U6bm93cmFwOwogIG9wYWNpdHk6MDsgcG9pbnRlci1ldmVudHM6bm9uZTsgdHJhbnNpdGlvbjpvcGFjaXR5IC4xOHM7IHotaW5kZXg6OTk7Cn0KLnRpcDpob3Zlcjo6YWZ0ZXJ7b3BhY2l0eToxO30KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBDSEFSVArilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLmNoYXJ0LWNhcmQgewogIGJhY2tncm91bmQ6dmFyKC0tc3VyZik7IGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOjExcHg7IHBhZGRpbmc6MjJweDsgbWFyZ2luLWJvdHRvbToyMHB4OwogIGFuaW1hdGlvbjpmYWRlVXAgLjVzIC4zMnMgZWFzZSBib3RoOwp9Ci5jaGFydC10b3AgewogIGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjsKICBtYXJnaW4tYm90dG9tOjE2cHg7Cn0KLmNoYXJ0LXR0bCB7IGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXdlaWdodDo3MDA7IGZvbnQtc2l6ZToxM3B4OyB9Ci5jaGFydC1jb250cm9scyB7IGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBnYXA6OHB4OyB9CgoucGlsbHMgeyBkaXNwbGF5OmZsZXg7IGdhcDo1cHg7IH0KLnBpbGwgewogIGZvbnQtc2l6ZToxMHB4OyBwYWRkaW5nOjNweCAxMXB4OyBib3JkZXItcmFkaXVzOjIwcHg7CiAgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXJCKTsgY29sb3I6dmFyKC0tbXV0ZWQyKTsKICBiYWNrZ3JvdW5kOnRyYW5zcGFyZW50OyBjdXJzb3I6cG9pbnRlcjsgZm9udC1mYW1pbHk6dmFyKC0tbW9ubyk7CiAgdHJhbnNpdGlvbjphbGwgLjEzczsKfQoucGlsbC5vbiB7IGJhY2tncm91bmQ6dmFyKC0tbWVwKTsgYm9yZGVyLWNvbG9yOnZhcigtLW1lcCk7IGNvbG9yOiMwMDA7IGZvbnQtd2VpZ2h0OjcwMDsgfQouYnRuLWNzdiB7CiAgZm9udC1zaXplOjEwcHg7IHBhZGRpbmc6NHB4IDEwcHg7IGJvcmRlci1yYWRpdXM6MjBweDsKICBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlckIpOyBjb2xvcjp2YXIoLS1tdXRlZDIpOwogIGJhY2tncm91bmQ6dHJhbnNwYXJlbnQ7IGN1cnNvcjpwb2ludGVyOyBmb250LWZhbWlseTp2YXIoLS1tb25vKTsKICB0cmFuc2l0aW9uOmFsbCAuMTNzOwp9Ci5idG4tY3N2OmhvdmVyIHsgY29sb3I6dmFyKC0tdGV4dCk7IGJvcmRlci1jb2xvcjp2YXIoLS1tZXApOyB9CgoubGVnZW5kcyB7IGRpc3BsYXk6ZmxleDsgZ2FwOjE4cHg7IG1hcmdpbi1ib3R0b206MTRweDsgZm9udC1zaXplOjEwcHg7IGNvbG9yOnZhcigtLW11dGVkMik7IH0KLmxlZyB7IGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBnYXA6NXB4OyB9Ci5sZWctbGluZSB7IHdpZHRoOjE4cHg7IGhlaWdodDoycHg7IGJvcmRlci1yYWRpdXM6MnB4OyB9CgpzdmcuY2hhcnQgeyB3aWR0aDoxMDAlOyBoZWlnaHQ6MTcwcHg7IG92ZXJmbG93OnZpc2libGU7IH0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBNRVRSSUNTCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwoubWV0cmljcy1ncmlkIHsKICBkaXNwbGF5OmdyaWQ7IGdyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoNCwxZnIpOwogIGdhcDoxMnB4OyBtYXJnaW4tYm90dG9tOjIwcHg7Cn0KLm1jYXJkIHsKICBiYWNrZ3JvdW5kOnZhcigtLXN1cmYyKTsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yYWRpdXM6OXB4OyBwYWRkaW5nOjE0cHggMTZweDsKICBhbmltYXRpb246ZmFkZVVwIC41cyBlYXNlIGJvdGg7Cn0KLm1jYXJkOm50aC1jaGlsZCgxKXthbmltYXRpb24tZGVsYXk6LjM4czt9Ci5tY2FyZDpudGgtY2hpbGQoMil7YW5pbWF0aW9uLWRlbGF5Oi40M3M7fQoubWNhcmQ6bnRoLWNoaWxkKDMpe2FuaW1hdGlvbi1kZWxheTouNDhzO30KLm1jYXJkOm50aC1jaGlsZCg0KXthbmltYXRpb24tZGVsYXk6LjUzczt9Ci5tY2FyZC1sYWJlbCB7CiAgZm9udC1mYW1pbHk6dmFyKC0tc2Fucyk7IGZvbnQtc2l6ZTo5cHg7IGZvbnQtd2VpZ2h0OjcwMDsKICBsZXR0ZXItc3BhY2luZzouMWVtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7IGNvbG9yOnZhcigtLW11dGVkKTsgbWFyZ2luLWJvdHRvbTo3cHg7Cn0KLm1jYXJkLXZhbCB7IGZvbnQtc2l6ZToyMHB4OyBmb250LXdlaWdodDo3MDA7IH0KLm1jYXJkLXN1YiB7IGZvbnQtc2l6ZTo5cHg7IGNvbG9yOnZhcigtLW11dGVkKTsgbWFyZ2luLXRvcDozcHg7IH0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBUQUJMRQrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLnRhYmxlLWNhcmQgewogIGJhY2tncm91bmQ6dmFyKC0tc3VyZik7IGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOjExcHg7IG92ZXJmbG93OmhpZGRlbjsKICBhbmltYXRpb246ZmFkZVVwIC41cyAuNTZzIGVhc2UgYm90aDsKfQoudGFibGUtdG9wIHsKICBwYWRkaW5nOjE0cHggMjJweDsgYm9yZGVyLWJvdHRvbToxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBkaXNwbGF5OmZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsganVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47Cn0KLnRhYmxlLXR0bCB7IGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXdlaWdodDo3MDA7IGZvbnQtc2l6ZToxM3B4OyB9Ci50YWJsZS1jYXAgeyBmb250LXNpemU6MTBweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyB9CgouaGlzdG9yeS10YWJsZS13cmFwIHsgb3ZlcmZsb3cteDphdXRvOyB9Ci5oaXN0b3J5LXRhYmxlLXdyYXAgdGFibGUgewogIG1pbi13aWR0aDogODYwcHg7Cn0KdGFibGUgeyB3aWR0aDoxMDAlOyBib3JkZXItY29sbGFwc2U6Y29sbGFwc2U7IHRhYmxlLWxheW91dDpmaXhlZDsgfQp0aGVhZCB0aCB7CiAgZm9udC1zaXplOjlweDsgbGV0dGVyLXNwYWNpbmc6LjFlbTsgdGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOwogIGNvbG9yOnZhcigtLW11dGVkKTsgcGFkZGluZzo5cHggMjJweDsgdGV4dC1hbGlnbjpsZWZ0OwogIGJhY2tncm91bmQ6dmFyKC0tc3VyZjIpOyBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6NjAwOwogIHBvc2l0aW9uOnJlbGF0aXZlOwp9CnRib2R5IHRyIHsgYm9yZGVyLWJvdHRvbToxcHggc29saWQgdmFyKC0tYm9yZGVyKTsgdHJhbnNpdGlvbjpiYWNrZ3JvdW5kIC4xMnM7IH0KdGJvZHkgdHI6aG92ZXIgeyBiYWNrZ3JvdW5kOnJnYmEoNDEsMTgyLDI0NiwuMDQpOyB9CnRib2R5IHRyOmxhc3QtY2hpbGQgeyBib3JkZXItYm90dG9tOm5vbmU7IH0KdGJvZHkgdGQgewogIHBhZGRpbmc6MTFweCAyMnB4OyBmb250LXNpemU6MTJweDsKICBvdmVyZmxvdzpoaWRkZW47IHRleHQtb3ZlcmZsb3c6ZWxsaXBzaXM7IHdoaXRlLXNwYWNlOm5vd3JhcDsKfQp0ZC5kaW0geyBjb2xvcjp2YXIoLS1tdXRlZDIpOyBmb250LXNpemU6MTFweDsgfQp0ZC5kaW0gLnRzLWRheSB7IGZvbnQtc2l6ZTo5cHg7IGNvbG9yOnZhcigtLW11dGVkKTsgbGluZS1oZWlnaHQ6MS4xOyB9CnRkLmRpbSAudHMtaG91ciB7IGZvbnQtc2l6ZToxMXB4OyBjb2xvcjp2YXIoLS1tdXRlZDIpOyBsaW5lLWhlaWdodDoxLjI7IG1hcmdpbi10b3A6MnB4OyB9Ci5jb2wtbGFiZWwgeyBwYWRkaW5nLXJpZ2h0OjEwcHg7IGRpc3BsYXk6aW5saW5lLWJsb2NrOyB9Ci5jb2wtcmVzaXplciB7CiAgcG9zaXRpb246YWJzb2x1dGU7CiAgdG9wOjA7CiAgcmlnaHQ6LTRweDsKICB3aWR0aDo4cHg7CiAgaGVpZ2h0OjEwMCU7CiAgY3Vyc29yOmNvbC1yZXNpemU7CiAgdXNlci1zZWxlY3Q6bm9uZTsKICB0b3VjaC1hY3Rpb246bm9uZTsKICB6LWluZGV4OjI7Cn0KLmNvbC1yZXNpemVyOjphZnRlciB7CiAgY29udGVudDonJzsKICBwb3NpdGlvbjphYnNvbHV0ZTsKICB0b3A6NnB4OwogIGJvdHRvbTo2cHg7CiAgbGVmdDozcHg7CiAgd2lkdGg6MXB4OwogIGJhY2tncm91bmQ6cmdiYSgxMjIsMTQzLDE2OCwuMjgpOwp9Ci5jb2wtcmVzaXplcjpob3Zlcjo6YWZ0ZXIsCi5jb2wtcmVzaXplci5hY3RpdmU6OmFmdGVyIHsKICBiYWNrZ3JvdW5kOnJnYmEoMTIyLDE0MywxNjgsLjc1KTsKfQoKLnNiYWRnZSB7CiAgZGlzcGxheTppbmxpbmUtYmxvY2s7IGZvbnQtc2l6ZTo5cHg7IGZvbnQtd2VpZ2h0OjcwMDsKICBsZXR0ZXItc3BhY2luZzouMDhlbTsgcGFkZGluZzoycHggN3B4OyBib3JkZXItcmFkaXVzOjRweDsKICB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7Cn0KLnNiYWRnZS5zaW0geyBiYWNrZ3JvdW5kOnZhcigtLWdyZWVuLWQpOyBjb2xvcjp2YXIoLS1ncmVlbik7IGJvcmRlcjoxcHggc29saWQgcmdiYSgwLDIzMCwxMTgsLjIpOyB9Ci5zYmFkZ2Uubm9zaW0geyBiYWNrZ3JvdW5kOnZhcigtLXJlZC1kKTsgY29sb3I6dmFyKC0tcmVkKTsgYm9yZGVyOjFweCBzb2xpZCByZ2JhKDI1NSw3MSw4NywuMik7IH0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBGT09URVIgLyBHTE9TQVJJTwrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLmdsb3NhcmlvIHsKICBtYXJnaW4tdG9wOjIwcHg7IGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOjExcHg7IG92ZXJmbG93OmhpZGRlbjsKICBhbmltYXRpb246ZmFkZVVwIC41cyAuNnMgZWFzZSBib3RoOwp9Ci5nbG9zLWJ0biB7CiAgd2lkdGg6MTAwJTsgYmFja2dyb3VuZDp2YXIoLS1zdXJmKTsgYm9yZGVyOm5vbmU7CiAgY29sb3I6dmFyKC0tbXV0ZWQyKTsgZm9udC1mYW1pbHk6dmFyKC0tbW9ubyk7IGZvbnQtc2l6ZToxMXB4OwogIHBhZGRpbmc6MTNweCAyMnB4OyB0ZXh0LWFsaWduOmxlZnQ7IGN1cnNvcjpwb2ludGVyOwogIGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjsKICB0cmFuc2l0aW9uOmNvbG9yIC4xNXM7Cn0KLmdsb3MtYnRuOmhvdmVyIHsgY29sb3I6dmFyKC0tdGV4dCk7IH0KCi5nbG9zLWdyaWQgewogIGRpc3BsYXk6bm9uZTsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnI7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmMik7IGJvcmRlci10b3A6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Cn0KLmdsb3MtZ3JpZC5vcGVuIHsgZGlzcGxheTpncmlkOyB9CgouZ2kgewogIHBhZGRpbmc6MTRweCAyMnB4OyBib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yaWdodDoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKfQouZ2k6bnRoLWNoaWxkKGV2ZW4pe2JvcmRlci1yaWdodDpub25lO30KLmdpLXRlcm0gewogIGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXNpemU6MTBweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4wOGVtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7IGNvbG9yOnZhcigtLW11dGVkMik7IG1hcmdpbi1ib3R0b206M3B4Owp9Ci5naS1kZWYgeyBmb250LXNpemU6MTFweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBsaW5lLWhlaWdodDoxLjU7IH0KCmZvb3RlciB7CiAgdGV4dC1hbGlnbjpjZW50ZXI7IHBhZGRpbmc6MjJweDsgZm9udC1zaXplOjEwcHg7IGNvbG9yOnZhcigtLW11dGVkKTsKICBib3JkZXItdG9wOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwp9CmZvb3RlciBhIHsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgdGV4dC1kZWNvcmF0aW9uOm5vbmU7IH0KZm9vdGVyIGE6aG92ZXIgeyBjb2xvcjp2YXIoLS10ZXh0KTsgfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIEFOSU1BVElPTlMK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCkBrZXlmcmFtZXMgZmFkZUluIHsgZnJvbXtvcGFjaXR5OjA7fXRve29wYWNpdHk6MTt9IH0KQGtleWZyYW1lcyBmYWRlVXAgeyBmcm9te29wYWNpdHk6MDt0cmFuc2Zvcm06dHJhbnNsYXRlWSgxMHB4KTt9dG97b3BhY2l0eToxO3RyYW5zZm9ybTp0cmFuc2xhdGVZKDApO30gfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIFJFU1BPTlNJVkUK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCkBtZWRpYShtYXgtd2lkdGg6OTAwcHgpewogIDpyb290eyAtLWRyYXdlci13OiAxMDB2dzsgfQogIC5ib2R5LXdyYXAuZHJhd2VyLW9wZW4gLm1haW4tY29udGVudCB7IG1hcmdpbi1yaWdodDowOyB9CiAgLmRyYXdlciB7IHdpZHRoOjEwMHZ3OyB9Cn0KQG1lZGlhKG1heC13aWR0aDo3MDBweCl7CiAgLmhlcm8tZ3JpZHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnI7IH0KICAuaGNhcmQuZ2FweyBncmlkLWNvbHVtbjpzcGFuIDI7IH0KICAubWV0cmljcy1ncmlkeyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcjsgfQogIC5oY2FyZC12YWx7IGZvbnQtc2l6ZToyNnB4OyB9CiAgLmNoYXJ0LXRvcHsgYWxpZ24taXRlbXM6ZmxleC1zdGFydDsgZ2FwOjEwcHg7IH0KICAuY2hhcnQtY29udHJvbHN7IHdpZHRoOjEwMCU7IGp1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuOyB9CiAgLnBpbGxzeyBmbGV4LXdyYXA6d3JhcDsgfQogIHRoZWFkIHRoOm50aC1jaGlsZCg0KSwgdGJvZHkgdGQ6bnRoLWNoaWxkKDQpeyBkaXNwbGF5Om5vbmU7IH0KICAucy1yaWdodCB7IGRpc3BsYXk6bm9uZTsgfQogIHRkLmRpbSAudHMtZGF5IHsgZm9udC1zaXplOjhweDsgfQogIHRkLmRpbSAudHMtaG91ciB7IGZvbnQtc2l6ZToxMHB4OyB9Cn0KQG1lZGlhKG1heC13aWR0aDo0ODBweCl7CiAgLmhlcm8tZ3JpZHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcjsgfQogIC5oY2FyZC5nYXB7IGdyaWQtY29sdW1uOnNwYW4gMTsgfQogIGhlYWRlcnsgcGFkZGluZzowIDE0cHg7IH0KICAudGFnLW1lcmNhZG97IGRpc3BsYXk6bm9uZTsgfQogIC5idG4tdGFzYXMgc3Bhbi5sYWJlbC1sb25nIHsgZGlzcGxheTpub25lOyB9Cn0KCi8qIERSQVdFUiBPVkVSTEFZIChtb2JpbGUpICovCi5vdmVybGF5IHsKICBkaXNwbGF5Om5vbmU7CiAgcG9zaXRpb246Zml4ZWQ7IGluc2V0OjA7IHotaW5kZXg6MTQwOwogIGJhY2tncm91bmQ6cmdiYSgwLDAsMCwuNTUpOwogIGJhY2tkcm9wLWZpbHRlcjpibHVyKDJweCk7Cn0KQG1lZGlhKG1heC13aWR0aDo5MDBweCl7CiAgLm92ZXJsYXkuc2hvdyB7IGRpc3BsYXk6YmxvY2s7IH0KfQo8L3N0eWxlPgo8L2hlYWQ+Cjxib2R5Pgo8ZGl2IGNsYXNzPSJhcHAiPgoKPCEtLSDilIDilIAgSEVBREVSIOKUgOKUgCAtLT4KPGhlYWRlcj4KICA8ZGl2IGNsYXNzPSJsb2dvIj4KICAgIDxzcGFuIGNsYXNzPSJsaXZlLWRvdCI+PC9zcGFuPgogICAgUkFEQVIgTUVQL0NDTAogIDwvZGl2PgogIDxkaXYgY2xhc3M9ImhlYWRlci1yaWdodCI+CiAgICA8ZGl2IGNsYXNzPSJmcmVzaC1iYWRnZSIgaWQ9ImZyZXNoLWJhZGdlIj4KICAgICAgPHNwYW4gY2xhc3M9ImZyZXNoLWRvdCI+PC9zcGFuPgogICAgICA8c3BhbiBpZD0iZnJlc2gtYmFkZ2UtdGV4dCI+QWN0dWFsaXphbmRv4oCmPC9zcGFuPgogICAgPC9kaXY+CiAgICA8c3BhbiBjbGFzcz0idGFnLW1lcmNhZG8gY2xvc2VkIiBpZD0idGFnLW1lcmNhZG8iPk1lcmNhZG8gY2VycmFkbzwvc3Bhbj4KICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tdGFzYXMiIGlkPSJidG5UYXNhcyIgb25jbGljaz0idG9nZ2xlRHJhd2VyKCkiPgogICAgICDwn5OKIDxzcGFuIGNsYXNzPSJsYWJlbC1sb25nIj5UYXNhcyAmYW1wOyBCb25vczwvc3Bhbj4KICAgIDwvYnV0dG9uPgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1hbGVydCI+8J+UlCBBbGVydGFzPC9idXR0b24+CiAgPC9kaXY+CjwvaGVhZGVyPgoKPCEtLSDilIDilIAgT1ZFUkxBWSAobW9iaWxlKSDilIDilIAgLS0+CjxkaXYgY2xhc3M9Im92ZXJsYXkiIGlkPSJvdmVybGF5IiBvbmNsaWNrPSJ0b2dnbGVEcmF3ZXIoKSI+PC9kaXY+Cgo8IS0tIOKUgOKUgCBCT0RZIFdSQVAg4pSA4pSAIC0tPgo8ZGl2IGNsYXNzPSJib2R5LXdyYXAiIGlkPSJib2R5V3JhcCI+CgogIDwhLS0g4pWQ4pWQ4pWQ4pWQIE1BSU4g4pWQ4pWQ4pWQ4pWQIC0tPgogIDxkaXYgY2xhc3M9Im1haW4tY29udGVudCI+CgogICAgPCEtLSBTVEFUVVMgQkFOTkVSIC0tPgogICAgPGRpdiBjbGFzcz0ic3RhdHVzLWJhbm5lciBzaW1pbGFyIiBpZD0ic3RhdHVzLWJhbm5lciI+CiAgICAgIDxkaXYgY2xhc3M9InMtbGVmdCI+CiAgICAgICAgPGRpdiBjbGFzcz0icy10aXRsZSI+CiAgICAgICAgICA8c3BhbiBpZD0ic3RhdHVzLWxhYmVsIj5NRVAg4omIIENDTDwvc3Bhbj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJzLWJhZGdlIiBpZD0ic3RhdHVzLWJhZGdlIj5TaW1pbGFyPC9zcGFuPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InMtc3ViIj5MYSBicmVjaGEgZXN0w6EgZGVudHJvIGRlbCB1bWJyYWwg4oCUIGxvcyBwcmVjaW9zIHNvbiBjb21wYXJhYmxlczwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0icy1yaWdodCI+CiAgICAgICAgPGRpdj7Dmmx0aW1hIGNvcnJpZGE6IDxzdHJvbmcgaWQ9Imxhc3QtcnVuLXRpbWUiPuKAlDwvc3Ryb25nPjwvZGl2PgogICAgICAgIDxkaXYgaWQ9ImNvdW50ZG93bi10ZXh0Ij5QcsOzeGltYSBhY3R1YWxpemFjacOzbiBlbiA1OjAwPC9kaXY+CiAgICAgICAgPGRpdj5Dcm9uIEdNVC0zIMK3IEx1buKAk1ZpZSAxMDozMOKAkzE4OjAwPC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJlcnJvci1iYW5uZXIiIGlkPSJlcnJvci1iYW5uZXIiPgogICAgICA8c3BhbiBpZD0iZXJyb3ItYmFubmVyLXRleHQiPkVycm9yIGFsIGFjdHVhbGl6YXIgwrcgUmVpbnRlbnRhcjwvc3Bhbj4KICAgICAgPGJ1dHRvbiBpZD0iZXJyb3ItcmV0cnktYnRuIiB0eXBlPSJidXR0b24iPlJlaW50ZW50YXI8L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDwhLS0gSEVSTyBDQVJEUyAtLT4KICAgIDxkaXYgY2xhc3M9Imhlcm8tZ3JpZCI+CiAgICAgIDxkaXYgY2xhc3M9ImhjYXJkIG1lcCI+CiAgICAgICAgPGRpdiBjbGFzcz0iYmFyIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC1sYWJlbCI+CiAgICAgICAgICA8c3BhbiBjbGFzcz0iZG90Ij48L3NwYW4+CiAgICAgICAgICA8c3BhbiBjbGFzcz0idGlwIiBkYXRhLXQ9IkTDs2xhciBCb2xzYSDigJQgY29tcHJhL3ZlbnRhIGRlIGJvbm9zIGVuICRBUlMgeSBVU0QiPk1FUCB2ZW50YSDik5g8L3NwYW4+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtdmFsIiBpZD0ibWVwLXZhbCI+JDEuMjY0PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtc3ViIj5kb2xhcml0by5hciDCtyB2ZW50YTwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaGNhcmQgY2NsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJiYXIiPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLWxhYmVsIj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJkb3QiPjwvc3Bhbj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0aXAiIGRhdGEtdD0iQ29udGFkbyBjb24gTGlxdWlkYWNpw7NuIOKAlCBzaW1pbGFyIGFsIE1FUCBjb24gZ2lybyBhbCBleHRlcmlvciI+Q0NMIHZlbnRhIOKTmDwvc3Bhbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC12YWwiIGlkPSJjY2wtdmFsIj4kMS4yNzE8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC1zdWIiPmRvbGFyaXRvLmFyIMK3IHZlbnRhPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoY2FyZCBnYXAiPgogICAgICAgIDxkaXYgY2xhc3M9ImJhciI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtbGFiZWwiPgogICAgICAgICAgPHNwYW4gY2xhc3M9ImRvdCI+PC9zcGFuPgogICAgICAgICAgPHNwYW4gY2xhc3M9InRpcCIgZGF0YS10PSJCcmVjaGEgcmVsYXRpdmEgY29udHJhIGVsIHByb21lZGlvIGVudHJlIE1FUCB5IENDTCI+QnJlY2hhIOKTmDwvc3Bhbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC12YWwiIGlkPSJicmVjaGEtYWJzIj4kNzwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLXBjdCIgaWQ9ImJyZWNoYS1wY3QiPjAuNTUlPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtc3ViIj5kaWZlcmVuY2lhIGFic29sdXRhIMK3IHBvcmNlbnR1YWw8L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8IS0tIENIQVJUIC0tPgogICAgPGRpdiBjbGFzcz0iY2hhcnQtY2FyZCI+CiAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0LXRvcCI+CiAgICAgICAgPGRpdiBjbGFzcz0iY2hhcnQtdHRsIiBpZD0idHJlbmQtdGl0bGUiPlRlbmRlbmNpYSBNRVAvQ0NMIOKAlCAxIGTDrWE8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJjaGFydC1jb250cm9scyI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJwaWxscyI+CiAgICAgICAgICAgIDxidXR0b24gY2xhc3M9InBpbGwgb24iIGRhdGEtZmlsdGVyPSIxZCI+MSBEw61hPC9idXR0b24+CiAgICAgICAgICAgIDxidXR0b24gY2xhc3M9InBpbGwiIGRhdGEtZmlsdGVyPSIxdyI+MSBTZW1hbmE8L2J1dHRvbj4KICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz0icGlsbCIgZGF0YS1maWx0ZXI9IjFtIj4xIE1lczwvYnV0dG9uPgogICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4tY3N2IiBpZD0iYnRuLWRvd25sb2FkLWNzdiIgdHlwZT0iYnV0dG9uIj5EZXNjYXJnYXIgQ1NWPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJsZWdlbmRzIj4KICAgICAgICA8ZGl2IGNsYXNzPSJsZWciPjxkaXYgY2xhc3M9ImxlZy1saW5lIiBzdHlsZT0iYmFja2dyb3VuZDp2YXIoLS1tZXApIj48L2Rpdj5NRVA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJsZWciPjxkaXYgY2xhc3M9ImxlZy1saW5lIiBzdHlsZT0iYmFja2dyb3VuZDp2YXIoLS1jY2wpIj48L2Rpdj5DQ0w8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxzdmcgY2xhc3M9ImNoYXJ0IiBpZD0idHJlbmQtY2hhcnQiIHZpZXdCb3g9IjAgMCA4NjAgMTYwIiBwcmVzZXJ2ZUFzcGVjdFJhdGlvPSJub25lIj4KICAgICAgICA8bGluZSB4MT0iMCIgeTE9IjQwIiB4Mj0iODYwIiB5Mj0iNDAiIHN0cm9rZT0iIzFlMjUzMCIgc3Ryb2tlLXdpZHRoPSIxIi8+CiAgICAgICAgPGxpbmUgeDE9IjAiIHkxPSI4MCIgeDI9Ijg2MCIgeTI9IjgwIiBzdHJva2U9IiMxZTI1MzAiIHN0cm9rZS13aWR0aD0iMSIvPgogICAgICAgIDxsaW5lIHgxPSIwIiB5MT0iMTIwIiB4Mj0iODYwIiB5Mj0iMTIwIiBzdHJva2U9IiMxZTI1MzAiIHN0cm9rZS13aWR0aD0iMSIvPgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC15LXRvcCIgeD0iMiIgeT0iMzciIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iOCIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteS1taWQiIHg9IjIiIHk9Ijc3IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjgiIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXktbG93IiB4PSIyIiB5PSIxMTciIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iOCIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICA8cG9seWxpbmUgaWQ9InRyZW5kLW1lcC1saW5lIiBwb2ludHM9IiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMjliNmY2IiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz4KICAgICAgICA8cG9seWxpbmUgaWQ9InRyZW5kLWNjbC1saW5lIiBwb2ludHM9IiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjYjM5ZGRiIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz4KICAgICAgICA8bGluZSBpZD0idHJlbmQtaG92ZXItbGluZSIgeDE9IjAiIHkxPSIxOCIgeDI9IjAiIHkyPSIxMzIiIHN0cm9rZT0iIzJhMzQ0NCIgc3Ryb2tlLXdpZHRoPSIxIiBvcGFjaXR5PSIwIi8+CiAgICAgICAgPGNpcmNsZSBpZD0idHJlbmQtaG92ZXItbWVwIiBjeD0iMCIgY3k9IjAiIHI9IjMuNSIgZmlsbD0iIzI5YjZmNiIgb3BhY2l0eT0iMCIvPgogICAgICAgIDxjaXJjbGUgaWQ9InRyZW5kLWhvdmVyLWNjbCIgY3g9IjAiIGN5PSIwIiByPSIzLjUiIGZpbGw9IiNiMzlkZGIiIG9wYWNpdHk9IjAiLz4KICAgICAgICA8ZyBpZD0idHJlbmQtdG9vbHRpcCIgb3BhY2l0eT0iMCI+CiAgICAgICAgICA8cmVjdCBpZD0idHJlbmQtdG9vbHRpcC1iZyIgeD0iMCIgeT0iMCIgd2lkdGg9IjE0OCIgaGVpZ2h0PSI1NiIgcng9IjYiIGZpbGw9IiMxNjFiMjIiIHN0cm9rZT0iIzJhMzQ0NCIvPgogICAgICAgICAgPHRleHQgaWQ9InRyZW5kLXRpcC10aW1lIiB4PSIxMCIgeT0iMTQiIGZpbGw9IiM1NTYwNzAiIGZvbnQtc2l6ZT0iOCIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC10aXAtbWVwIiB4PSIxMCIgeT0iMjgiIGZpbGw9IiMyOWI2ZjYiIGZvbnQtc2l6ZT0iOSIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPk1FUCDigJQ8L3RleHQ+CiAgICAgICAgICA8dGV4dCBpZD0idHJlbmQtdGlwLWNjbCIgeD0iMTAiIHk9IjQwIiBmaWxsPSIjYjM5ZGRiIiBmb250LXNpemU9IjkiIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj5DQ0wg4oCUPC90ZXh0PgogICAgICAgICAgPHRleHQgaWQ9InRyZW5kLXRpcC1nYXAiIHg9IjEwIiB5PSI1MiIgZmlsbD0iI2ZmY2MwMCIgZm9udC1zaXplPSI4IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+QnJlY2hhIOKAlDwvdGV4dD4KICAgICAgICA8L2c+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXgtMSIgeD0iMjgiIHk9IjE1NCIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI3IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC14LTIiIHg9IjIxOCIgeT0iMTU0IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjciIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXgtMyIgeD0iNDE4IiB5PSIxNTQiIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iNyIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteC00IiB4PSI2MDgiIHk9IjE1NCIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI3IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC14LTUiIHg9Ijc5OCIgeT0iMTU0IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjciIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgIDwvc3ZnPgogICAgPC9kaXY+CgogICAgPCEtLSBNRVRSSUNTIC0tPgogICAgPGRpdiBjbGFzcz0ibWV0cmljcy1ncmlkIj4KICAgICAgPGRpdiBjbGFzcz0ibWNhcmQiPgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLWxhYmVsIiBpZD0ibWV0cmljLWNvdW50LWxhYmVsIj5NdWVzdHJhcyAxIGTDrWE8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC12YWwiIGlkPSJtZXRyaWMtY291bnQtMjRoIj7igJQ8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1zdWIiIGlkPSJtZXRyaWMtY291bnQtc3ViIj5yZWdpc3Ryb3MgZGVsIHBlcsOtb2RvIGZpbHRyYWRvPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJtY2FyZCI+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtbGFiZWwiIGlkPSJtZXRyaWMtc2ltaWxhci1sYWJlbCI+VmVjZXMgc2ltaWxhcjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXZhbCIgc3R5bGU9ImNvbG9yOnZhcigtLWdyZWVuKSIgaWQ9Im1ldHJpYy1zaW1pbGFyLTI0aCI+4oCUPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtc3ViIiBpZD0ibWV0cmljLXNpbWlsYXItc3ViIj5tb21lbnRvcyBlbiB6b25hIOKJpDElIG8g4omkJDEwPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJtY2FyZCI+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtbGFiZWwiIGlkPSJtZXRyaWMtbWluLWxhYmVsIj5CcmVjaGEgbcOtbi48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC12YWwiIGlkPSJtZXRyaWMtbWluLTI0aCI+4oCUPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtc3ViIiBpZD0ibWV0cmljLW1pbi1zdWIiPm3DrW5pbWEgZGVsIHBlcsOtb2RvIGZpbHRyYWRvPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJtY2FyZCI+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtbGFiZWwiIGlkPSJtZXRyaWMtbWF4LWxhYmVsIj5CcmVjaGEgbcOheC48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC12YWwiIHN0eWxlPSJjb2xvcjp2YXIoLS15ZWxsb3cpIiBpZD0ibWV0cmljLW1heC0yNGgiPuKAlDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXN1YiIgaWQ9Im1ldHJpYy1tYXgtc3ViIj5tw6F4aW1hIGRlbCBwZXLDrW9kbyBmaWx0cmFkbzwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAgIDwhLS0gVEFCTEUgLS0+CiAgICA8ZGl2IGNsYXNzPSJ0YWJsZS1jYXJkIj4KICAgICAgPGRpdiBjbGFzcz0idGFibGUtdG9wIj4KICAgICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS10dGwiPkhpc3RvcmlhbCBkZSByZWdpc3Ryb3M8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS1jYXAiIGlkPSJoaXN0b3J5LWNhcCI+w5psdGltYXMg4oCUIG11ZXN0cmFzPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoaXN0b3J5LXRhYmxlLXdyYXAiPgogICAgICA8dGFibGUgaWQ9Imhpc3RvcnktdGFibGUiPgogICAgICAgIDxjb2xncm91cCBpZD0iaGlzdG9yeS1jb2xncm91cCI+CiAgICAgICAgICA8Y29sIGRhdGEtY29sLWluZGV4PSIwIj4KICAgICAgICAgIDxjb2wgZGF0YS1jb2wtaW5kZXg9IjEiPgogICAgICAgICAgPGNvbCBkYXRhLWNvbC1pbmRleD0iMiI+CiAgICAgICAgICA8Y29sIGRhdGEtY29sLWluZGV4PSIzIj4KICAgICAgICAgIDxjb2wgZGF0YS1jb2wtaW5kZXg9IjQiPgogICAgICAgICAgPGNvbCBkYXRhLWNvbC1pbmRleD0iNSI+CiAgICAgICAgPC9jb2xncm91cD4KICAgICAgICA8dGhlYWQ+CiAgICAgICAgICA8dHI+CiAgICAgICAgICAgIDx0aD48c3BhbiBjbGFzcz0iY29sLWxhYmVsIj5Ew61hIC8gSG9yYTwvc3Bhbj48c3BhbiBjbGFzcz0iY29sLXJlc2l6ZXIiIGRhdGEtY29sLWluZGV4PSIwIiByb2xlPSJzZXBhcmF0b3IiIGFyaWEtbGFiZWw9IkFqdXN0YXIgYW5jaG8gZGUgRMOtYSAvIEhvcmEiPjwvc3Bhbj48L3RoPgogICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImNvbC1sYWJlbCI+TUVQPC9zcGFuPjxzcGFuIGNsYXNzPSJjb2wtcmVzaXplciIgZGF0YS1jb2wtaW5kZXg9IjEiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBNRVAiPjwvc3Bhbj48L3RoPgogICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImNvbC1sYWJlbCI+Q0NMPC9zcGFuPjxzcGFuIGNsYXNzPSJjb2wtcmVzaXplciIgZGF0YS1jb2wtaW5kZXg9IjIiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBDQ0wiPjwvc3Bhbj48L3RoPgogICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImNvbC1sYWJlbCI+RGlmICQ8L3NwYW4+PHNwYW4gY2xhc3M9ImNvbC1yZXNpemVyIiBkYXRhLWNvbC1pbmRleD0iMyIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIERpZiAkIj48L3NwYW4+PC90aD4KICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJjb2wtbGFiZWwiPkRpZiAlPC9zcGFuPjxzcGFuIGNsYXNzPSJjb2wtcmVzaXplciIgZGF0YS1jb2wtaW5kZXg9IjQiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBEaWYgJSI+PC9zcGFuPjwvdGg+CiAgICAgICAgICAgIDx0aD48c3BhbiBjbGFzcz0iY29sLWxhYmVsIj5Fc3RhZG88L3NwYW4+PHNwYW4gY2xhc3M9ImNvbC1yZXNpemVyIiBkYXRhLWNvbC1pbmRleD0iNSIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIEVzdGFkbyI+PC9zcGFuPjwvdGg+CiAgICAgICAgICA8L3RyPgogICAgICAgIDwvdGhlYWQ+CiAgICAgICAgPHRib2R5IGlkPSJoaXN0b3J5LXJvd3MiPjwvdGJvZHk+CiAgICAgIDwvdGFibGU+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgPCEtLSBHTE9TQVJJTyAtLT4KICAgIDxkaXYgY2xhc3M9Imdsb3NhcmlvIj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iZ2xvcy1idG4iIG9uY2xpY2s9InRvZ2dsZUdsb3ModGhpcykiPgogICAgICAgIDxzcGFuPvCfk5YgR2xvc2FyaW8gZGUgdMOpcm1pbm9zPC9zcGFuPgogICAgICAgIDxzcGFuIGlkPSJnbG9zQXJyb3ciPuKWvjwvc3Bhbj4KICAgICAgPC9idXR0b24+CiAgICAgIDxkaXYgY2xhc3M9Imdsb3MtZ3JpZCIgaWQ9Imdsb3NHcmlkIj4KICAgICAgICA8ZGl2IGNsYXNzPSJnaSI+PGRpdiBjbGFzcz0iZ2ktdGVybSI+TUVQIHZlbnRhPC9kaXY+PGRpdiBjbGFzcz0iZ2ktZGVmIj5QcmVjaW8gZGUgdmVudGEgZGVsIGTDs2xhciBNRVAgKE1lcmNhZG8gRWxlY3Ryw7NuaWNvIGRlIFBhZ29zKSB2w61hIGNvbXByYS92ZW50YSBkZSBib25vcyBlbiAkQVJTIHkgVVNELjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImdpIj48ZGl2IGNsYXNzPSJnaS10ZXJtIj5DQ0wgdmVudGE8L2Rpdj48ZGl2IGNsYXNzPSJnaS1kZWYiPkNvbnRhZG8gY29uIExpcXVpZGFjacOzbiDigJQgc2ltaWxhciBhbCBNRVAgcGVybyBwZXJtaXRlIHRyYW5zZmVyaXIgZm9uZG9zIGFsIGV4dGVyaW9yLiBTdWVsZSBjb3RpemFyIGxldmVtZW50ZSBwb3IgZW5jaW1hLjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImdpIj48ZGl2IGNsYXNzPSJnaS10ZXJtIj5EaWZlcmVuY2lhICU8L2Rpdj48ZGl2IGNsYXNzPSJnaS1kZWYiPkJyZWNoYSByZWxhdGl2YSBjYWxjdWxhZGEgY29udHJhIGVsIHByb21lZGlvIGVudHJlIE1FUCB5IENDTC4gVW1icmFsIFNJTUlMQVI6IOKJpCAxJSBvIOKJpCAkMTAgQVJTLjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImdpIj48ZGl2IGNsYXNzPSJnaS10ZXJtIj5GcmVzY3VyYSBkZWwgZGF0bzwvZGl2PjxkaXYgY2xhc3M9ImdpLWRlZiI+VGllbXBvIGRlc2RlIGVsIMO6bHRpbW8gdGltZXN0YW1wIGRlIGRvbGFyaXRvLmFyLiBFbCBjcm9uIGNvcnJlIGNhZGEgNSBtaW4gZW4gZMOtYXMgaMOhYmlsZXMuPC9kaXY+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZ2kiPjxkaXYgY2xhc3M9ImdpLXRlcm0iPkVzdGFkbyBTSU1JTEFSPC9kaXY+PGRpdiBjbGFzcz0iZ2ktZGVmIj5DdWFuZG8gTUVQIHkgQ0NMIGVzdMOhbiBkZW50cm8gZGVsIHVtYnJhbCDigJQgbW9tZW50byBpZGVhbCBwYXJhIG9wZXJhciBidXNjYW5kbyBwYXJpZGFkIGVudHJlIGFtYm9zIHRpcG9zLjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImdpIj48ZGl2IGNsYXNzPSJnaS10ZXJtIj5NZXJjYWRvIEFSRzwvZGl2PjxkaXYgY2xhc3M9ImdpLWRlZiI+VmVudGFuYSBvcGVyYXRpdmE6IGx1bmVzIGEgdmllcm5lcyBkZSAxMDozMCBhIDE3OjU5IChHTVQtMywgQnVlbm9zIEFpcmVzKS48L2Rpdj48L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8Zm9vdGVyPgogICAgICBGdWVudGU6IDxhIGhyZWY9IiMiPmRvbGFyaXRvLmFyPC9hPiDCtyA8YSBocmVmPSIjIj5ieW1hLmNvbS5hcjwvYT4gwrcgRGF0b3MgY2FkYSA1IG1pbiBlbiBkw61hcyBow6FiaWxlcyDCtyA8YSBocmVmPSIjIj5SZXBvcnRhciBwcm9ibGVtYTwvYT4KICAgIDwvZm9vdGVyPgoKICA8L2Rpdj48IS0tIC9tYWluLWNvbnRlbnQgLS0+CgogIDwhLS0g4pWQ4pWQ4pWQ4pWQIERSQVdFUiDilZDilZDilZDilZAgLS0+CiAgPGRpdiBjbGFzcz0iZHJhd2VyIiBpZD0iZHJhd2VyIj4KCiAgICA8ZGl2IGNsYXNzPSJkcmF3ZXItaGVhZGVyIj4KICAgICAgPGRpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJkcmF3ZXItdGl0bGUiPvCfk4ogVGFzYXMgJmFtcDsgQm9ub3M8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJkcmF3ZXItc291cmNlIj5GdWVudGVzOiBkb2xhcml0by5hciDCtyBieW1hLmNvbS5hcjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuLWNsb3NlIiBvbmNsaWNrPSJ0b2dnbGVEcmF3ZXIoKSI+4pyVPC9idXR0b24+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJkcmF3ZXItYm9keSI+CiAgICAgIDxkaXYgY2xhc3M9ImNvbnRleHQtYm94Ij4KICAgICAgICA8c3Ryb25nPlByw7N4aW1hbWVudGU8L3N0cm9uZz48YnI+CiAgICAgICAgRXN0YSBzZWNjacOzbiBkZSBUYXNhcyB5IEJvbm9zIHNlIGVuY3VlbnRyYSBlbiByZXZpc2nDs24geSB2b2x2ZXLDoSBlbiB1bmEgcHLDs3hpbWEgdmVyc2nDs24uCiAgICAgIDwvZGl2PgoKICAgIDwvZGl2PjwhLS0gL2RyYXdlci1ib2R5IC0tPgogIDwvZGl2PjwhLS0gL2RyYXdlciAtLT4KCjwvZGl2PjwhLS0gL2JvZHktd3JhcCAtLT4KPC9kaXY+PCEtLSAvYXBwIC0tPgoKPHNjcmlwdD4KICAvLyAxKSBDb25zdGFudGVzIHkgY29uZmlndXJhY2nDs24KICBjb25zdCBFTkRQT0lOVFMgPSB7CiAgICBtZXBDY2w6ICcvYXBpL2RhdGEnCiAgfTsKICBjb25zdCBBUkdfVFogPSAnQW1lcmljYS9BcmdlbnRpbmEvQnVlbm9zX0FpcmVzJzsKICBjb25zdCBGRVRDSF9JTlRFUlZBTF9NUyA9IDMwMDAwMDsKICBjb25zdCBDQUNIRV9LRVkgPSAncmFkYXJfY2FjaGUnOwogIGNvbnN0IEhJU1RPUllfQ09MU19LRVkgPSAncmFkYXJfaGlzdG9yeV9jb2xfd2lkdGhzX3YxJzsKICBjb25zdCBDQUNIRV9UVExfTVMgPSAxNSAqIDYwICogMTAwMDsKICBjb25zdCBSRVRSWV9ERUxBWVMgPSBbMTAwMDAsIDMwMDAwLCA2MDAwMF07CiAgY29uc3QgU0lNSUxBUl9QQ1RfVEhSRVNIT0xEID0gMTsKICBjb25zdCBTSU1JTEFSX0FSU19USFJFU0hPTEQgPSAxMDsKICBjb25zdCBUUkVORF9NQVhfUE9JTlRTID0gMjQwOwogIGNvbnN0IEhJU1RPUllfREVGQVVMVF9DT0xfV0lEVEhTID0gWzE3MCwgMTYwLCAxNjAsIDEyMCwgMTIwLCAxNzBdOwogIGNvbnN0IEhJU1RPUllfTUlOX0NPTF9XSURUSFMgPSBbMTIwLCAxMTAsIDExMCwgOTAsIDkwLCAxMjBdOwogIGNvbnN0IE5VTUVSSUNfSURTID0gWwogICAgJ21lcC12YWwnLCAnY2NsLXZhbCcsICdicmVjaGEtYWJzJywgJ2JyZWNoYS1wY3QnCiAgXTsKICBjb25zdCBzdGF0ZSA9IHsKICAgIHJldHJ5SW5kZXg6IDAsCiAgICByZXRyeVRpbWVyOiBudWxsLAogICAgbGFzdFN1Y2Nlc3NBdDogMCwKICAgIGlzRmV0Y2hpbmc6IGZhbHNlLAogICAgZmlsdGVyTW9kZTogJzFkJywKICAgIGxhc3RNZXBQYXlsb2FkOiBudWxsLAogICAgdHJlbmRSb3dzOiBbXSwKICAgIHRyZW5kSG92ZXJCb3VuZDogZmFsc2UsCiAgICBoaXN0b3J5UmVzaXplQm91bmQ6IGZhbHNlLAogICAgaGlzdG9yeUNvbFdpZHRoczogW10sCiAgICBzb3VyY2VUc01zOiBudWxsLAogICAgZnJlc2hCYWRnZU1vZGU6ICdpZGxlJywKICAgIGZyZXNoVGlja2VyOiBudWxsLAogICAgbGF0ZXN0OiB7CiAgICAgIG1lcDogbnVsbCwKICAgICAgY2NsOiBudWxsLAogICAgICBicmVjaGFBYnM6IG51bGwsCiAgICAgIGJyZWNoYVBjdDogbnVsbAogICAgfQogIH07CgogIC8vIDIpIEhlbHBlcnMKICBjb25zdCBmbXRBcmdUaW1lID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VzLUFSJywgewogICAgdGltZVpvbmU6IEFSR19UWiwKICAgIGhvdXI6ICcyLWRpZ2l0JywKICAgIG1pbnV0ZTogJzItZGlnaXQnCiAgfSk7CiAgY29uc3QgZm10QXJnVGltZVNlYyA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlcy1BUicsIHsKICAgIHRpbWVab25lOiBBUkdfVFosCiAgICBob3VyOiAnMi1kaWdpdCcsCiAgICBtaW51dGU6ICcyLWRpZ2l0JywKICAgIHNlY29uZDogJzItZGlnaXQnCiAgfSk7CiAgY29uc3QgZm10QXJnSG91ciA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlcy1BUicsIHsKICAgIHRpbWVab25lOiBBUkdfVFosCiAgICBob3VyOiAnMi1kaWdpdCcsCiAgICBtaW51dGU6ICcyLWRpZ2l0JywKICAgIGhvdXIxMjogZmFsc2UKICB9KTsKICBjb25zdCBmbXRBcmdEYXlNb250aCA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlcy1BUicsIHsKICAgIHRpbWVab25lOiBBUkdfVFosCiAgICBkYXk6ICcyLWRpZ2l0JywKICAgIG1vbnRoOiAnMi1kaWdpdCcKICB9KTsKICBjb25zdCBmbXRBcmdEYXRlID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VuLUNBJywgewogICAgdGltZVpvbmU6IEFSR19UWiwKICAgIHllYXI6ICdudW1lcmljJywKICAgIG1vbnRoOiAnMi1kaWdpdCcsCiAgICBkYXk6ICcyLWRpZ2l0JwogIH0pOwogIGNvbnN0IGZtdEFyZ1dlZWtkYXkgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZW4tVVMnLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgd2Vla2RheTogJ3Nob3J0JwogIH0pOwogIGNvbnN0IGZtdEFyZ1BhcnRzID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VuLVVTJywgewogICAgdGltZVpvbmU6IEFSR19UWiwKICAgIHdlZWtkYXk6ICdzaG9ydCcsCiAgICBob3VyOiAnMi1kaWdpdCcsCiAgICBtaW51dGU6ICcyLWRpZ2l0JywKICAgIHNlY29uZDogJzItZGlnaXQnLAogICAgaG91cjEyOiBmYWxzZQogIH0pOwogIGNvbnN0IFdFRUtEQVkgPSB7IE1vbjogMSwgVHVlOiAyLCBXZWQ6IDMsIFRodTogNCwgRnJpOiA1LCBTYXQ6IDYsIFN1bjogNyB9OwoKICBmdW5jdGlvbiB0b051bWJlcih2YWx1ZSkgewogICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHZhbHVlKSkgcmV0dXJuIHZhbHVlOwogICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycpIHsKICAgICAgY29uc3Qgbm9ybWFsaXplZCA9IHZhbHVlLnJlcGxhY2UoL1xzL2csICcnKS5yZXBsYWNlKCcsJywgJy4nKS5yZXBsYWNlKC9bXlxkLi1dL2csICcnKTsKICAgICAgY29uc3QgcGFyc2VkID0gTnVtYmVyKG5vcm1hbGl6ZWQpOwogICAgICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHBhcnNlZCkgPyBwYXJzZWQgOiBudWxsOwogICAgfQogICAgcmV0dXJuIG51bGw7CiAgfQogIGZ1bmN0aW9uIGdldFBhdGgob2JqLCBwYXRoKSB7CiAgICByZXR1cm4gcGF0aC5yZWR1Y2UoKGFjYywga2V5KSA9PiAoYWNjICYmIGFjY1trZXldICE9PSB1bmRlZmluZWQgPyBhY2Nba2V5XSA6IHVuZGVmaW5lZCksIG9iaik7CiAgfQogIGZ1bmN0aW9uIHBpY2tOdW1iZXIob2JqLCBwYXRocykgewogICAgZm9yIChjb25zdCBwYXRoIG9mIHBhdGhzKSB7CiAgICAgIGNvbnN0IHYgPSBnZXRQYXRoKG9iaiwgcGF0aCk7CiAgICAgIGNvbnN0IG4gPSB0b051bWJlcih2KTsKICAgICAgaWYgKG4gIT09IG51bGwpIHJldHVybiBuOwogICAgfQogICAgcmV0dXJuIG51bGw7CiAgfQogIGZ1bmN0aW9uIHBpY2tCeUtleUhpbnQob2JqLCBoaW50KSB7CiAgICBpZiAoIW9iaiB8fCB0eXBlb2Ygb2JqICE9PSAnb2JqZWN0JykgcmV0dXJuIG51bGw7CiAgICBjb25zdCBsb3dlciA9IGhpbnQudG9Mb3dlckNhc2UoKTsKICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKG9iaikpIHsKICAgICAgaWYgKGsudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhsb3dlcikpIHsKICAgICAgICBjb25zdCBuID0gdG9OdW1iZXIodik7CiAgICAgICAgaWYgKG4gIT09IG51bGwpIHJldHVybiBuOwogICAgICAgIGlmICh2ICYmIHR5cGVvZiB2ID09PSAnb2JqZWN0JykgewogICAgICAgICAgY29uc3QgZGVlcCA9IHBpY2tCeUtleUhpbnQodiwgaGludCk7CiAgICAgICAgICBpZiAoZGVlcCAhPT0gbnVsbCkgcmV0dXJuIGRlZXA7CiAgICAgICAgfQogICAgICB9CiAgICAgIGlmICh2ICYmIHR5cGVvZiB2ID09PSAnb2JqZWN0JykgewogICAgICAgIGNvbnN0IGRlZXAgPSBwaWNrQnlLZXlIaW50KHYsIGhpbnQpOwogICAgICAgIGlmIChkZWVwICE9PSBudWxsKSByZXR1cm4gZGVlcDsKICAgICAgfQogICAgfQogICAgcmV0dXJuIG51bGw7CiAgfQogIGZ1bmN0aW9uIGdldEFyZ05vd1BhcnRzKGRhdGUgPSBuZXcgRGF0ZSgpKSB7CiAgICBjb25zdCBwYXJ0cyA9IGZtdEFyZ1BhcnRzLmZvcm1hdFRvUGFydHMoZGF0ZSkucmVkdWNlKChhY2MsIHApID0+IHsKICAgICAgYWNjW3AudHlwZV0gPSBwLnZhbHVlOwogICAgICByZXR1cm4gYWNjOwogICAgfSwge30pOwogICAgcmV0dXJuIHsKICAgICAgd2Vla2RheTogV0VFS0RBWVtwYXJ0cy53ZWVrZGF5XSB8fCAwLAogICAgICBob3VyOiBOdW1iZXIocGFydHMuaG91ciB8fCAnMCcpLAogICAgICBtaW51dGU6IE51bWJlcihwYXJ0cy5taW51dGUgfHwgJzAnKSwKICAgICAgc2Vjb25kOiBOdW1iZXIocGFydHMuc2Vjb25kIHx8ICcwJykKICAgIH07CiAgfQogIGZ1bmN0aW9uIGJyZWNoYVBlcmNlbnQobWVwLCBjY2wpIHsKICAgIGlmIChtZXAgPT09IG51bGwgfHwgY2NsID09PSBudWxsKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGF2ZyA9IChtZXAgKyBjY2wpIC8gMjsKICAgIGlmICghYXZnKSByZXR1cm4gbnVsbDsKICAgIHJldHVybiAoTWF0aC5hYnMobWVwIC0gY2NsKSAvIGF2ZykgKiAxMDA7CiAgfQogIGZ1bmN0aW9uIGZvcm1hdE1vbmV5KHZhbHVlLCBkaWdpdHMgPSAwKSB7CiAgICBpZiAodmFsdWUgPT09IG51bGwpIHJldHVybiAn4oCUJzsKICAgIHJldHVybiAnJCcgKyB2YWx1ZS50b0xvY2FsZVN0cmluZygnZXMtQVInLCB7CiAgICAgIG1pbmltdW1GcmFjdGlvbkRpZ2l0czogZGlnaXRzLAogICAgICBtYXhpbXVtRnJhY3Rpb25EaWdpdHM6IGRpZ2l0cwogICAgfSk7CiAgfQogIGZ1bmN0aW9uIGZvcm1hdFBlcmNlbnQodmFsdWUsIGRpZ2l0cyA9IDIpIHsKICAgIGlmICh2YWx1ZSA9PT0gbnVsbCkgcmV0dXJuICfigJQnOwogICAgcmV0dXJuIHZhbHVlLnRvRml4ZWQoZGlnaXRzKSArICclJzsKICB9CiAgZnVuY3Rpb24gc2V0VGV4dChpZCwgdGV4dCwgb3B0aW9ucyA9IHt9KSB7CiAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKTsKICAgIGlmICghZWwpIHJldHVybjsKICAgIGNvbnN0IG5leHQgPSBTdHJpbmcodGV4dCk7CiAgICBjb25zdCBwcmV2ID0gZWwudGV4dENvbnRlbnQ7CiAgICBlbC50ZXh0Q29udGVudCA9IG5leHQ7CiAgICBlbC5jbGFzc0xpc3QucmVtb3ZlKCdza2VsZXRvbicpOwogICAgaWYgKG9wdGlvbnMuY2hhbmdlQ2xhc3MgJiYgcHJldiAhPT0gbmV4dCkgewogICAgICBlbC5jbGFzc0xpc3QuYWRkKCd2YWx1ZS1jaGFuZ2VkJyk7CiAgICAgIHNldFRpbWVvdXQoKCkgPT4gZWwuY2xhc3NMaXN0LnJlbW92ZSgndmFsdWUtY2hhbmdlZCcpLCA2MDApOwogICAgfQogIH0KICBmdW5jdGlvbiBzZXREYXNoKGlkcykgewogICAgaWRzLmZvckVhY2goKGlkKSA9PiBzZXRUZXh0KGlkLCAn4oCUJykpOwogIH0KICBmdW5jdGlvbiBzZXRMb2FkaW5nKGlkcywgaXNMb2FkaW5nKSB7CiAgICBpZHMuZm9yRWFjaCgoaWQpID0+IHsKICAgICAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7CiAgICAgIGlmICghZWwpIHJldHVybjsKICAgICAgZWwuY2xhc3NMaXN0LnRvZ2dsZSgnc2tlbGV0b24nLCBpc0xvYWRpbmcpOwogICAgfSk7CiAgfQogIGZ1bmN0aW9uIHNldEZyZXNoQmFkZ2UodGV4dCwgbW9kZSkgewogICAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZnJlc2gtYmFkZ2UnKTsKICAgIGNvbnN0IGxhYmVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZyZXNoLWJhZGdlLXRleHQnKTsKICAgIGlmICghYmFkZ2UgfHwgIWxhYmVsKSByZXR1cm47CiAgICBsYWJlbC50ZXh0Q29udGVudCA9IHRleHQ7CiAgICBzdGF0ZS5mcmVzaEJhZGdlTW9kZSA9IG1vZGUgfHwgJ2lkbGUnOwogICAgYmFkZ2UuY2xhc3NMaXN0LnRvZ2dsZSgnZmV0Y2hpbmcnLCBtb2RlID09PSAnZmV0Y2hpbmcnKTsKICAgIGJhZGdlLmNsYXNzTGlzdC50b2dnbGUoJ2Vycm9yJywgbW9kZSA9PT0gJ2Vycm9yJyk7CiAgICBiYWRnZS5vbmNsaWNrID0gbW9kZSA9PT0gJ2Vycm9yJyA/ICgpID0+IGZldGNoQWxsKHsgbWFudWFsOiB0cnVlIH0pIDogbnVsbDsKICB9CiAgZnVuY3Rpb24gZm9ybWF0U291cmNlQWdlTGFiZWwodHNNcykgewogICAgbGV0IG4gPSB0b051bWJlcih0c01zKTsKICAgIGlmICghTnVtYmVyLmlzRmluaXRlKG4pKSByZXR1cm4gbnVsbDsKICAgIGlmIChuIDwgMWUxMikgbiAqPSAxMDAwOwogICAgY29uc3QgYWdlTWluID0gTWF0aC5tYXgoMCwgTWF0aC5mbG9vcigoRGF0ZS5ub3coKSAtIG4pIC8gNjAwMDApKTsKICAgIGlmIChhZ2VNaW4gPCA2MCkgcmV0dXJuIGAke2FnZU1pbn0gbWluYDsKICAgIGNvbnN0IGggPSBNYXRoLmZsb29yKGFnZU1pbiAvIDYwKTsKICAgIGNvbnN0IG0gPSBhZ2VNaW4gJSA2MDsKICAgIHJldHVybiBtID09PSAwID8gYCR7aH0gaGAgOiBgJHtofSBoICR7bX0gbWluYDsKICB9CiAgZnVuY3Rpb24gcmVmcmVzaEZyZXNoQmFkZ2VGcm9tU291cmNlKCkgewogICAgaWYgKHN0YXRlLmZyZXNoQmFkZ2VNb2RlID09PSAnZmV0Y2hpbmcnIHx8IHN0YXRlLmZyZXNoQmFkZ2VNb2RlID09PSAnZXJyb3InKSByZXR1cm47CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShzdGF0ZS5zb3VyY2VUc01zKSkgcmV0dXJuOwogICAgY29uc3QgYWdlTGFiZWwgPSBmb3JtYXRTb3VyY2VBZ2VMYWJlbChzdGF0ZS5zb3VyY2VUc01zKTsKICAgIGlmICghYWdlTGFiZWwpIHJldHVybjsKICAgIHNldEZyZXNoQmFkZ2UoYMOabHRpbWEgYWN0dWFsaXphY2nDs24gaGFjZTogJHthZ2VMYWJlbH1gLCAnaWRsZScpOwogIH0KICBmdW5jdGlvbiBzdGFydEZyZXNoVGlja2VyKCkgewogICAgaWYgKHN0YXRlLmZyZXNoVGlja2VyKSByZXR1cm47CiAgICBzdGF0ZS5mcmVzaFRpY2tlciA9IHNldEludGVydmFsKHJlZnJlc2hGcmVzaEJhZGdlRnJvbVNvdXJjZSwgMzAwMDApOwogIH0KICBmdW5jdGlvbiBzZXRNYXJrZXRUYWcoaXNPcGVuKSB7CiAgICBjb25zdCB0YWcgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndGFnLW1lcmNhZG8nKTsKICAgIGlmICghdGFnKSByZXR1cm47CiAgICB0YWcudGV4dENvbnRlbnQgPSBpc09wZW4gPyAnTWVyY2FkbyBhYmllcnRvJyA6ICdNZXJjYWRvIGNlcnJhZG8nOwogICAgdGFnLmNsYXNzTGlzdC50b2dnbGUoJ2Nsb3NlZCcsICFpc09wZW4pOwogIH0KICBmdW5jdGlvbiBzZXRFcnJvckJhbm5lcihzaG93LCB0ZXh0KSB7CiAgICBjb25zdCBiYW5uZXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZXJyb3ItYmFubmVyJyk7CiAgICBjb25zdCBsYWJlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdlcnJvci1iYW5uZXItdGV4dCcpOwogICAgaWYgKCFiYW5uZXIpIHJldHVybjsKICAgIGlmICh0ZXh0ICYmIGxhYmVsKSBsYWJlbC50ZXh0Q29udGVudCA9IHRleHQ7CiAgICBiYW5uZXIuY2xhc3NMaXN0LnRvZ2dsZSgnc2hvdycsICEhc2hvdyk7CiAgfQogIGZ1bmN0aW9uIGV4dHJhY3RSb290KGpzb24pIHsKICAgIHJldHVybiBqc29uICYmIHR5cGVvZiBqc29uID09PSAnb2JqZWN0JyA/IChqc29uLmRhdGEgfHwganNvbi5yZXN1bHQgfHwganNvbikgOiB7fTsKICB9CiAgZnVuY3Rpb24gZ2V0SGlzdG9yeUNvbEVsZW1lbnRzKCkgewogICAgY29uc3QgY29sZ3JvdXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGlzdG9yeS1jb2xncm91cCcpOwogICAgcmV0dXJuIGNvbGdyb3VwID8gQXJyYXkuZnJvbShjb2xncm91cC5xdWVyeVNlbGVjdG9yQWxsKCdjb2wnKSkgOiBbXTsKICB9CiAgZnVuY3Rpb24gY2xhbXBIaXN0b3J5V2lkdGhzKHdpZHRocykgewogICAgcmV0dXJuIEhJU1RPUllfREVGQVVMVF9DT0xfV0lEVEhTLm1hcCgoZmFsbGJhY2ssIGkpID0+IHsKICAgICAgY29uc3QgcmF3ID0gTnVtYmVyKHdpZHRocz8uW2ldKTsKICAgICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUocmF3KSkgcmV0dXJuIGZhbGxiYWNrOwogICAgICBjb25zdCBtaW4gPSBISVNUT1JZX01JTl9DT0xfV0lEVEhTW2ldID8/IDgwOwogICAgICByZXR1cm4gTWF0aC5tYXgobWluLCBNYXRoLnJvdW5kKHJhdykpOwogICAgfSk7CiAgfQogIGZ1bmN0aW9uIHNhdmVIaXN0b3J5Q29sdW1uV2lkdGhzKHdpZHRocykgewogICAgdHJ5IHsKICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oSElTVE9SWV9DT0xTX0tFWSwgSlNPTi5zdHJpbmdpZnkoY2xhbXBIaXN0b3J5V2lkdGhzKHdpZHRocykpKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgY29uc29sZS5lcnJvcignW1JhZGFyTUVQXSBubyBzZSBwdWRvIGd1YXJkYXIgYW5jaG9zIGRlIGNvbHVtbmFzJywgZSk7CiAgICB9CiAgfQogIGZ1bmN0aW9uIGxvYWRIaXN0b3J5Q29sdW1uV2lkdGhzKCkgewogICAgdHJ5IHsKICAgICAgY29uc3QgcmF3ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oSElTVE9SWV9DT0xTX0tFWSk7CiAgICAgIGlmICghcmF3KSByZXR1cm4gbnVsbDsKICAgICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyYXcpOwogICAgICBpZiAoIUFycmF5LmlzQXJyYXkocGFyc2VkKSB8fCBwYXJzZWQubGVuZ3RoICE9PSBISVNUT1JZX0RFRkFVTFRfQ09MX1dJRFRIUy5sZW5ndGgpIHJldHVybiBudWxsOwogICAgICByZXR1cm4gY2xhbXBIaXN0b3J5V2lkdGhzKHBhcnNlZCk7CiAgICB9IGNhdGNoIChlKSB7CiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tSYWRhck1FUF0gYW5jaG9zIGRlIGNvbHVtbmFzIGludsOhbGlkb3MnLCBlKTsKICAgICAgcmV0dXJuIG51bGw7CiAgICB9CiAgfQogIGZ1bmN0aW9uIGFwcGx5SGlzdG9yeUNvbHVtbldpZHRocyh3aWR0aHMsIHBlcnNpc3QgPSBmYWxzZSkgewogICAgY29uc3QgY29scyA9IGdldEhpc3RvcnlDb2xFbGVtZW50cygpOwogICAgaWYgKGNvbHMubGVuZ3RoICE9PSBISVNUT1JZX0RFRkFVTFRfQ09MX1dJRFRIUy5sZW5ndGgpIHJldHVybjsKICAgIGNvbnN0IG5leHQgPSBjbGFtcEhpc3RvcnlXaWR0aHMod2lkdGhzKTsKICAgIGNvbHMuZm9yRWFjaCgoY29sLCBpKSA9PiB7CiAgICAgIGNvbC5zdHlsZS53aWR0aCA9IGAke25leHRbaV19cHhgOwogICAgfSk7CiAgICBzdGF0ZS5oaXN0b3J5Q29sV2lkdGhzID0gbmV4dDsKICAgIGlmIChwZXJzaXN0KSBzYXZlSGlzdG9yeUNvbHVtbldpZHRocyhuZXh0KTsKICB9CiAgZnVuY3Rpb24gaW5pdEhpc3RvcnlDb2x1bW5XaWR0aHMoKSB7CiAgICBjb25zdCBzYXZlZCA9IGxvYWRIaXN0b3J5Q29sdW1uV2lkdGhzKCk7CiAgICBhcHBseUhpc3RvcnlDb2x1bW5XaWR0aHMoc2F2ZWQgfHwgSElTVE9SWV9ERUZBVUxUX0NPTF9XSURUSFMsIGZhbHNlKTsKICB9CiAgZnVuY3Rpb24gYmluZEhpc3RvcnlDb2x1bW5SZXNpemUoKSB7CiAgICBpZiAoc3RhdGUuaGlzdG9yeVJlc2l6ZUJvdW5kKSByZXR1cm47CiAgICBjb25zdCB0YWJsZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoaXN0b3J5LXRhYmxlJyk7CiAgICBpZiAoIXRhYmxlKSByZXR1cm47CiAgICBjb25zdCBoYW5kbGVzID0gQXJyYXkuZnJvbSh0YWJsZS5xdWVyeVNlbGVjdG9yQWxsKCcuY29sLXJlc2l6ZXInKSk7CiAgICBpZiAoIWhhbmRsZXMubGVuZ3RoKSByZXR1cm47CiAgICBzdGF0ZS5oaXN0b3J5UmVzaXplQm91bmQgPSB0cnVlOwoKICAgIGhhbmRsZXMuZm9yRWFjaCgoaGFuZGxlKSA9PiB7CiAgICAgIGhhbmRsZS5hZGRFdmVudExpc3RlbmVyKCdkYmxjbGljaycsIChldmVudCkgPT4gewogICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7CiAgICAgICAgY29uc3QgaWR4ID0gTnVtYmVyKGhhbmRsZS5kYXRhc2V0LmNvbEluZGV4KTsKICAgICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShpZHgpKSByZXR1cm47CiAgICAgICAgY29uc3QgbmV4dCA9IHN0YXRlLmhpc3RvcnlDb2xXaWR0aHMuc2xpY2UoKTsKICAgICAgICBuZXh0W2lkeF0gPSBISVNUT1JZX0RFRkFVTFRfQ09MX1dJRFRIU1tpZHhdOwogICAgICAgIGFwcGx5SGlzdG9yeUNvbHVtbldpZHRocyhuZXh0LCB0cnVlKTsKICAgICAgfSk7CiAgICAgIGhhbmRsZS5hZGRFdmVudExpc3RlbmVyKCdwb2ludGVyZG93bicsIChldmVudCkgPT4gewogICAgICAgIGlmIChldmVudC5idXR0b24gIT09IDApIHJldHVybjsKICAgICAgICBjb25zdCBpZHggPSBOdW1iZXIoaGFuZGxlLmRhdGFzZXQuY29sSW5kZXgpOwogICAgICAgIGlmICghTnVtYmVyLmlzRmluaXRlKGlkeCkpIHJldHVybjsKICAgICAgICBjb25zdCBzdGFydFggPSBldmVudC5jbGllbnRYOwogICAgICAgIGNvbnN0IHN0YXJ0V2lkdGggPSBzdGF0ZS5oaXN0b3J5Q29sV2lkdGhzW2lkeF0gPz8gSElTVE9SWV9ERUZBVUxUX0NPTF9XSURUSFNbaWR4XTsKICAgICAgICBoYW5kbGUuY2xhc3NMaXN0LmFkZCgnYWN0aXZlJyk7CiAgICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTsKCiAgICAgICAgY29uc3Qgb25Nb3ZlID0gKG1vdmVFdmVudCkgPT4gewogICAgICAgICAgY29uc3QgZGVsdGEgPSBtb3ZlRXZlbnQuY2xpZW50WCAtIHN0YXJ0WDsKICAgICAgICAgIGNvbnN0IG1pbiA9IEhJU1RPUllfTUlOX0NPTF9XSURUSFNbaWR4XSA/PyA4MDsKICAgICAgICAgIGNvbnN0IG5leHRXaWR0aCA9IE1hdGgubWF4KG1pbiwgTWF0aC5yb3VuZChzdGFydFdpZHRoICsgZGVsdGEpKTsKICAgICAgICAgIGNvbnN0IG5leHQgPSBzdGF0ZS5oaXN0b3J5Q29sV2lkdGhzLnNsaWNlKCk7CiAgICAgICAgICBuZXh0W2lkeF0gPSBuZXh0V2lkdGg7CiAgICAgICAgICBhcHBseUhpc3RvcnlDb2x1bW5XaWR0aHMobmV4dCwgZmFsc2UpOwogICAgICAgIH07CiAgICAgICAgY29uc3Qgb25VcCA9ICgpID0+IHsKICAgICAgICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKCdwb2ludGVybW92ZScsIG9uTW92ZSk7CiAgICAgICAgICB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcigncG9pbnRlcnVwJywgb25VcCk7CiAgICAgICAgICBoYW5kbGUuY2xhc3NMaXN0LnJlbW92ZSgnYWN0aXZlJyk7CiAgICAgICAgICBzYXZlSGlzdG9yeUNvbHVtbldpZHRocyhzdGF0ZS5oaXN0b3J5Q29sV2lkdGhzKTsKICAgICAgICB9OwogICAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdwb2ludGVybW92ZScsIG9uTW92ZSk7CiAgICAgICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJ1cCcsIG9uVXApOwogICAgICB9KTsKICAgIH0pOwogIH0KCiAgLy8gMykgRnVuY2lvbmVzIGRlIHJlbmRlcgogIGZ1bmN0aW9uIHJlbmRlck1lcENjbChwYXlsb2FkKSB7CiAgICBpZiAoIXBheWxvYWQpIHsKICAgICAgc2V0RGFzaChbJ21lcC12YWwnLCAnY2NsLXZhbCcsICdicmVjaGEtYWJzJywgJ2JyZWNoYS1wY3QnXSk7CiAgICAgIHNldFRleHQoJ3N0YXR1cy1sYWJlbCcsICdEYXRvcyBpbmNvbXBsZXRvcycpOwogICAgICBzZXRUZXh0KCdzdGF0dXMtYmFkZ2UnLCAnU2luIGRhdG8nKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgY29uc3QgZGF0YSA9IGV4dHJhY3RSb290KHBheWxvYWQpOwogICAgY29uc3QgY3VycmVudCA9IGRhdGEgJiYgdHlwZW9mIGRhdGEuY3VycmVudCA9PT0gJ29iamVjdCcgPyBkYXRhLmN1cnJlbnQgOiBudWxsOwogICAgY29uc3QgbWVwID0gY3VycmVudCA/IHRvTnVtYmVyKGN1cnJlbnQubWVwKSA6IChwaWNrTnVtYmVyKGRhdGEsIFtbJ21lcCcsICd2ZW50YSddLCBbJ21lcCcsICdzZWxsJ10sIFsnbWVwJ10sIFsnbWVwX3ZlbnRhJ10sIFsnZG9sYXJfbWVwJ11dKSA/PyBwaWNrQnlLZXlIaW50KGRhdGEsICdtZXAnKSk7CiAgICBjb25zdCBjY2wgPSBjdXJyZW50ID8gdG9OdW1iZXIoY3VycmVudC5jY2wpIDogKHBpY2tOdW1iZXIoZGF0YSwgW1snY2NsJywgJ3ZlbnRhJ10sIFsnY2NsJywgJ3NlbGwnXSwgWydjY2wnXSwgWydjY2xfdmVudGEnXSwgWydkb2xhcl9jY2wnXV0pID8/IHBpY2tCeUtleUhpbnQoZGF0YSwgJ2NjbCcpKTsKICAgIGNvbnN0IGFicyA9IGN1cnJlbnQgPyB0b051bWJlcihjdXJyZW50LmFic0RpZmYpID8/IChtZXAgIT09IG51bGwgJiYgY2NsICE9PSBudWxsID8gTWF0aC5hYnMobWVwIC0gY2NsKSA6IG51bGwpIDogKG1lcCAhPT0gbnVsbCAmJiBjY2wgIT09IG51bGwgPyBNYXRoLmFicyhtZXAgLSBjY2wpIDogbnVsbCk7CiAgICBjb25zdCBwY3QgPSBjdXJyZW50ID8gdG9OdW1iZXIoY3VycmVudC5wY3REaWZmKSA/PyBicmVjaGFQZXJjZW50KG1lcCwgY2NsKSA6IGJyZWNoYVBlcmNlbnQobWVwLCBjY2wpOwogICAgY29uc3QgaXNTaW1pbGFyID0gY3VycmVudCAmJiB0eXBlb2YgY3VycmVudC5zaW1pbGFyID09PSAnYm9vbGVhbicKICAgICAgPyBjdXJyZW50LnNpbWlsYXIKICAgICAgOiAocGN0ICE9PSBudWxsICYmIGFicyAhPT0gbnVsbCAmJiAocGN0IDw9IFNJTUlMQVJfUENUX1RIUkVTSE9MRCB8fCBhYnMgPD0gU0lNSUxBUl9BUlNfVEhSRVNIT0xEKSk7CgogICAgc2V0VGV4dCgnbWVwLXZhbCcsIGZvcm1hdE1vbmV5KG1lcCwgMiksIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdjY2wtdmFsJywgZm9ybWF0TW9uZXkoY2NsLCAyKSwgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ2JyZWNoYS1hYnMnLCBhYnMgPT09IG51bGwgPyAn4oCUJyA6IGZvcm1hdE1vbmV5KGFicywgMiksIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdicmVjaGEtcGN0JywgZm9ybWF0UGVyY2VudChwY3QsIDIpLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc2V0VGV4dCgnc3RhdHVzLWxhYmVsJywgaXNTaW1pbGFyID8gJ01FUCDiiYggQ0NMJyA6ICdNRVAg4omgIENDTCcpOwogICAgc2V0VGV4dCgnc3RhdHVzLWJhZGdlJywgaXNTaW1pbGFyID8gJ1NpbWlsYXInIDogJ05vIHNpbWlsYXInKTsKICAgIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3N0YXR1cy1iYWRnZScpOwogICAgaWYgKGJhZGdlKSBiYWRnZS5jbGFzc0xpc3QudG9nZ2xlKCdub3NpbScsICFpc1NpbWlsYXIpOwoKICAgIGNvbnN0IGJhbm5lciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzdGF0dXMtYmFubmVyJyk7CiAgICBpZiAoYmFubmVyKSB7CiAgICAgIGJhbm5lci5jbGFzc0xpc3QudG9nZ2xlKCdzaW1pbGFyJywgISFpc1NpbWlsYXIpOwogICAgICBiYW5uZXIuY2xhc3NMaXN0LnRvZ2dsZSgnbm8tc2ltaWxhcicsICFpc1NpbWlsYXIpOwogICAgfQogICAgY29uc3Qgc3ViID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignI3N0YXR1cy1iYW5uZXIgLnMtc3ViJyk7CiAgICBpZiAoc3ViKSB7CiAgICAgIHN1Yi50ZXh0Q29udGVudCA9IGlzU2ltaWxhcgogICAgICAgID8gJ0xhIGJyZWNoYSBlc3TDoSBkZW50cm8gZGVsIHVtYnJhbCDigJQgbG9zIHByZWNpb3Mgc29uIGNvbXBhcmFibGVzJwogICAgICAgIDogJ0xhIGJyZWNoYSBzdXBlcmEgZWwgdW1icmFsIOKAlCBsb3MgcHJlY2lvcyBubyBzb24gY29tcGFyYWJsZXMnOwogICAgfQogICAgY29uc3QgaXNPcGVuID0gZGF0YT8ubWFya2V0ICYmIHR5cGVvZiBkYXRhLm1hcmtldC5pc09wZW4gPT09ICdib29sZWFuJyA/IGRhdGEubWFya2V0LmlzT3BlbiA6IG51bGw7CiAgICBpZiAoaXNPcGVuICE9PSBudWxsKSBzZXRNYXJrZXRUYWcoaXNPcGVuKTsKICAgIHN0YXRlLmxhdGVzdC5tZXAgPSBtZXA7CiAgICBzdGF0ZS5sYXRlc3QuY2NsID0gY2NsOwogICAgc3RhdGUubGF0ZXN0LmJyZWNoYUFicyA9IGFiczsKICAgIHN0YXRlLmxhdGVzdC5icmVjaGFQY3QgPSBwY3Q7CiAgfQoKICBmdW5jdGlvbiBpc1NpbWlsYXJSb3cocm93KSB7CiAgICBjb25zdCBhYnMgPSByb3cuYWJzX2RpZmYgIT0gbnVsbCA/IHJvdy5hYnNfZGlmZiA6IE1hdGguYWJzKHJvdy5tZXAgLSByb3cuY2NsKTsKICAgIGNvbnN0IHBjdCA9IHJvdy5wY3RfZGlmZiAhPSBudWxsID8gcm93LnBjdF9kaWZmIDogY2FsY0JyZWNoYVBjdChyb3cubWVwLCByb3cuY2NsKTsKICAgIHJldHVybiAoTnVtYmVyLmlzRmluaXRlKHBjdCkgJiYgcGN0IDw9IFNJTUlMQVJfUENUX1RIUkVTSE9MRCkgfHwgKE51bWJlci5pc0Zpbml0ZShhYnMpICYmIGFicyA8PSBTSU1JTEFSX0FSU19USFJFU0hPTEQpOwogIH0KCiAgZnVuY3Rpb24gZmlsdGVyRGVzY3JpcHRvcihtb2RlID0gc3RhdGUuZmlsdGVyTW9kZSkgewogICAgaWYgKG1vZGUgPT09ICcxbScpIHJldHVybiAnMSBNZXMnOwogICAgaWYgKG1vZGUgPT09ICcxdycpIHJldHVybiAnMSBTZW1hbmEnOwogICAgcmV0dXJuICcxIETDrWEnOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyTWV0cmljczI0aChwYXlsb2FkKSB7CiAgICBjb25zdCBmaWx0ZXJlZCA9IGZpbHRlckhpc3RvcnlSb3dzKGV4dHJhY3RIaXN0b3J5Um93cyhwYXlsb2FkKSwgc3RhdGUuZmlsdGVyTW9kZSk7CiAgICBjb25zdCBwY3RWYWx1ZXMgPSBmaWx0ZXJlZC5tYXAoKHIpID0+IChyLnBjdF9kaWZmICE9IG51bGwgPyByLnBjdF9kaWZmIDogY2FsY0JyZWNoYVBjdChyLm1lcCwgci5jY2wpKSkuZmlsdGVyKCh2KSA9PiBOdW1iZXIuaXNGaW5pdGUodikpOwogICAgY29uc3Qgc2ltaWxhckNvdW50ID0gZmlsdGVyZWQuZmlsdGVyKChyKSA9PiBpc1NpbWlsYXJSb3cocikpLmxlbmd0aDsKICAgIGNvbnN0IGRlc2NyaXB0b3IgPSBmaWx0ZXJEZXNjcmlwdG9yKCk7CgogICAgc2V0VGV4dCgnbWV0cmljLWNvdW50LWxhYmVsJywgYE11ZXN0cmFzICR7ZGVzY3JpcHRvcn1gKTsKICAgIHNldFRleHQoJ21ldHJpYy1jb3VudC0yNGgnLCBTdHJpbmcoZmlsdGVyZWQubGVuZ3RoKSwgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ21ldHJpYy1jb3VudC1zdWInLCAncmVnaXN0cm9zIGRlbCBwZXLDrW9kbyBmaWx0cmFkbycpOwogICAgc2V0VGV4dCgnbWV0cmljLXNpbWlsYXItbGFiZWwnLCBgVmVjZXMgc2ltaWxhciAoJHtkZXNjcmlwdG9yfSlgKTsKICAgIHNldFRleHQoJ21ldHJpYy1zaW1pbGFyLTI0aCcsIFN0cmluZyhzaW1pbGFyQ291bnQpLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc2V0VGV4dCgnbWV0cmljLXNpbWlsYXItc3ViJywgJ21vbWVudG9zIGVuIHpvbmEg4omkMSUgbyDiiaQkMTAnKTsKICAgIHNldFRleHQoJ21ldHJpYy1taW4tbGFiZWwnLCBgQnJlY2hhIG3DrW4uICgke2Rlc2NyaXB0b3J9KWApOwogICAgc2V0VGV4dCgnbWV0cmljLW1pbi0yNGgnLCBwY3RWYWx1ZXMubGVuZ3RoID8gZm9ybWF0UGVyY2VudChNYXRoLm1pbiguLi5wY3RWYWx1ZXMpLCAyKSA6ICfigJQnLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc2V0VGV4dCgnbWV0cmljLW1pbi1zdWInLCAnbcOtbmltYSBkZWwgcGVyw61vZG8gZmlsdHJhZG8nKTsKICAgIHNldFRleHQoJ21ldHJpYy1tYXgtbGFiZWwnLCBgQnJlY2hhIG3DoXguICgke2Rlc2NyaXB0b3J9KWApOwogICAgc2V0VGV4dCgnbWV0cmljLW1heC0yNGgnLCBwY3RWYWx1ZXMubGVuZ3RoID8gZm9ybWF0UGVyY2VudChNYXRoLm1heCguLi5wY3RWYWx1ZXMpLCAyKSA6ICfigJQnLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc2V0VGV4dCgnbWV0cmljLW1heC1zdWInLCAnbcOheGltYSBkZWwgcGVyw61vZG8gZmlsdHJhZG8nKTsKICAgIHNldFRleHQoJ3RyZW5kLXRpdGxlJywgYFRlbmRlbmNpYSBNRVAvQ0NMIOKAlCAke2Rlc2NyaXB0b3J9YCk7CiAgfQoKICBmdW5jdGlvbiByb3dIb3VyTGFiZWwoZXBvY2gpIHsKICAgIGNvbnN0IG4gPSB0b051bWJlcihlcG9jaCk7CiAgICBpZiAobiA9PT0gbnVsbCkgcmV0dXJuICfigJQnOwogICAgcmV0dXJuIGZtdEFyZ0hvdXIuZm9ybWF0KG5ldyBEYXRlKG4gKiAxMDAwKSk7CiAgfQogIGZ1bmN0aW9uIHJvd0RheUhvdXJMYWJlbChlcG9jaCkgewogICAgY29uc3QgbiA9IHRvTnVtYmVyKGVwb2NoKTsKICAgIGlmIChuID09PSBudWxsKSByZXR1cm4gJ+KAlCc7CiAgICBjb25zdCBkYXRlID0gbmV3IERhdGUobiAqIDEwMDApOwogICAgcmV0dXJuIGAke2ZtdEFyZ0RheU1vbnRoLmZvcm1hdChkYXRlKX0gJHtmbXRBcmdIb3VyLmZvcm1hdChkYXRlKX1gOwogIH0KICBmdW5jdGlvbiBhcnREYXRlS2V5KGVwb2NoKSB7CiAgICBjb25zdCBuID0gdG9OdW1iZXIoZXBvY2gpOwogICAgaWYgKG4gPT09IG51bGwpIHJldHVybiBudWxsOwogICAgcmV0dXJuIGZtdEFyZ0RhdGUuZm9ybWF0KG5ldyBEYXRlKG4gKiAxMDAwKSk7CiAgfQogIGZ1bmN0aW9uIGFydFdlZWtkYXkoZXBvY2gpIHsKICAgIGNvbnN0IG4gPSB0b051bWJlcihlcG9jaCk7CiAgICBpZiAobiA9PT0gbnVsbCkgcmV0dXJuIG51bGw7CiAgICByZXR1cm4gZm10QXJnV2Vla2RheS5mb3JtYXQobmV3IERhdGUobiAqIDEwMDApKTsKICB9CiAgZnVuY3Rpb24gZXh0cmFjdEhpc3RvcnlSb3dzKHBheWxvYWQpIHsKICAgIGNvbnN0IGRhdGEgPSBleHRyYWN0Um9vdChwYXlsb2FkKTsKICAgIGNvbnN0IHJvd3MgPSBBcnJheS5pc0FycmF5KGRhdGEuaGlzdG9yeSkgPyBkYXRhLmhpc3Rvcnkuc2xpY2UoKSA6IFtdOwogICAgcmV0dXJuIHJvd3MKICAgICAgLm1hcCgocikgPT4gKHsKICAgICAgICBlcG9jaDogdG9OdW1iZXIoci5lcG9jaCksCiAgICAgICAgbWVwOiB0b051bWJlcihyLm1lcCksCiAgICAgICAgY2NsOiB0b051bWJlcihyLmNjbCksCiAgICAgICAgYWJzX2RpZmY6IHRvTnVtYmVyKHIuYWJzX2RpZmYpLAogICAgICAgIHBjdF9kaWZmOiB0b051bWJlcihyLnBjdF9kaWZmKSwKICAgICAgICBzaW1pbGFyOiBCb29sZWFuKHIuc2ltaWxhcikKICAgICAgfSkpCiAgICAgIC5maWx0ZXIoKHIpID0+IHIuZXBvY2ggIT0gbnVsbCAmJiByLm1lcCAhPSBudWxsICYmIHIuY2NsICE9IG51bGwpCiAgICAgIC5zb3J0KChhLCBiKSA9PiBhLmVwb2NoIC0gYi5lcG9jaCk7CiAgfQogIGZ1bmN0aW9uIGZpbHRlckhpc3RvcnlSb3dzKHJvd3MsIG1vZGUpIHsKICAgIGlmICghcm93cy5sZW5ndGgpIHJldHVybiBbXTsKICAgIGNvbnN0IGxhdGVzdEVwb2NoID0gcm93c1tyb3dzLmxlbmd0aCAtIDFdLmVwb2NoOwogICAgaWYgKG1vZGUgPT09ICcxbScpIHsKICAgICAgY29uc3QgY3V0b2ZmID0gbGF0ZXN0RXBvY2ggLSAoMzAgKiAyNCAqIDM2MDApOwogICAgICByZXR1cm4gcm93cy5maWx0ZXIoKHIpID0+IHIuZXBvY2ggPj0gY3V0b2ZmKTsKICAgIH0KICAgIGlmIChtb2RlID09PSAnMXcnKSB7CiAgICAgIGNvbnN0IGFsbG93ZWREYXlzID0gbmV3IFNldCgpOwogICAgICBmb3IgKGxldCBpID0gcm93cy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkgewogICAgICAgIGNvbnN0IGRheSA9IGFydERhdGVLZXkocm93c1tpXS5lcG9jaCk7CiAgICAgICAgY29uc3Qgd2QgPSBhcnRXZWVrZGF5KHJvd3NbaV0uZXBvY2gpOwogICAgICAgIGlmICghZGF5IHx8IHdkID09PSAnU2F0JyB8fCB3ZCA9PT0gJ1N1bicpIGNvbnRpbnVlOwogICAgICAgIGFsbG93ZWREYXlzLmFkZChkYXkpOwogICAgICAgIGlmIChhbGxvd2VkRGF5cy5zaXplID49IDUpIGJyZWFrOwogICAgICB9CiAgICAgIHJldHVybiByb3dzLmZpbHRlcigocikgPT4gewogICAgICAgIGNvbnN0IGRheSA9IGFydERhdGVLZXkoci5lcG9jaCk7CiAgICAgICAgcmV0dXJuIGRheSAmJiBhbGxvd2VkRGF5cy5oYXMoZGF5KTsKICAgICAgfSk7CiAgICB9CiAgICBjb25zdCBjdXRvZmYgPSBsYXRlc3RFcG9jaCAtICgyNCAqIDM2MDApOwogICAgcmV0dXJuIHJvd3MuZmlsdGVyKChyKSA9PiByLmVwb2NoID49IGN1dG9mZik7CiAgfQogIGZ1bmN0aW9uIGRvd25zYW1wbGVSb3dzKHJvd3MsIG1heFBvaW50cykgewogICAgaWYgKHJvd3MubGVuZ3RoIDw9IG1heFBvaW50cykgcmV0dXJuIHJvd3M7CiAgICBjb25zdCBvdXQgPSBbXTsKICAgIGNvbnN0IHN0ZXAgPSAocm93cy5sZW5ndGggLSAxKSAvIChtYXhQb2ludHMgLSAxKTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgbWF4UG9pbnRzOyBpKyspIHsKICAgICAgb3V0LnB1c2gocm93c1tNYXRoLnJvdW5kKGkgKiBzdGVwKV0pOwogICAgfQogICAgcmV0dXJuIG91dDsKICB9CiAgZnVuY3Rpb24gY3VycmVudEZpbHRlckxhYmVsKCkgewogICAgaWYgKHN0YXRlLmZpbHRlck1vZGUgPT09ICcxbScpIHJldHVybiAnMSBNZXMnOwogICAgaWYgKHN0YXRlLmZpbHRlck1vZGUgPT09ICcxdycpIHJldHVybiAnMSBTZW1hbmEnOwogICAgcmV0dXJuICcxIETDrWEnOwogIH0KICBmdW5jdGlvbiBnZXRGaWx0ZXJlZEhpc3RvcnlSb3dzKHBheWxvYWQgPSBzdGF0ZS5sYXN0TWVwUGF5bG9hZCkgewogICAgaWYgKCFwYXlsb2FkKSByZXR1cm4gW107CiAgICByZXR1cm4gZmlsdGVySGlzdG9yeVJvd3MoZXh0cmFjdEhpc3RvcnlSb3dzKHBheWxvYWQpLCBzdGF0ZS5maWx0ZXJNb2RlKTsKICB9CiAgZnVuY3Rpb24gY3N2RXNjYXBlKHZhbHVlKSB7CiAgICBjb25zdCB2ID0gU3RyaW5nKHZhbHVlID8/ICcnKTsKICAgIHJldHVybiBgIiR7di5yZXBsYWNlKC8iL2csICciIicpfSJgOwogIH0KICBmdW5jdGlvbiBjc3ZOdW1iZXIodmFsdWUsIGRpZ2l0cyA9IDIpIHsKICAgIGlmICghTnVtYmVyLmlzRmluaXRlKHZhbHVlKSkgcmV0dXJuICfigJQnOwogICAgcmV0dXJuIHZhbHVlLnRvRml4ZWQoZGlnaXRzKS5yZXBsYWNlKCcuJywgJywnKTsKICB9CiAgZnVuY3Rpb24gZmlsdGVyQ29kZSgpIHsKICAgIGlmIChzdGF0ZS5maWx0ZXJNb2RlID09PSAnMW0nKSByZXR1cm4gJzFtJzsKICAgIGlmIChzdGF0ZS5maWx0ZXJNb2RlID09PSAnMXcnKSByZXR1cm4gJzF3JzsKICAgIHJldHVybiAnMWQnOwogIH0KICBmdW5jdGlvbiBkb3dubG9hZEhpc3RvcnlDc3YoKSB7CiAgICBjb25zdCBmaWx0ZXJlZCA9IGdldEZpbHRlcmVkSGlzdG9yeVJvd3MoKTsKICAgIGlmICghZmlsdGVyZWQubGVuZ3RoKSB7CiAgICAgIHNldEZyZXNoQmFkZ2UoJ1NpbiBkYXRvcyBwYXJhIGV4cG9ydGFyIGVuIGVsIGZpbHRybyBhY3Rpdm8nLCAnaWRsZScpOwogICAgICByZXR1cm47CiAgICB9CiAgICBjb25zdCBoZWFkZXIgPSBbJ2ZlY2hhJywgJ2hvcmEnLCAnbWVwJywgJ2NjbCcsICdkaWZfYWJzJywgJ2RpZl9wY3QnLCAnZXN0YWRvJ107CiAgICBjb25zdCByb3dzID0gZmlsdGVyZWQubWFwKChyKSA9PiB7CiAgICAgIGNvbnN0IGRhdGUgPSBuZXcgRGF0ZShyLmVwb2NoICogMTAwMCk7CiAgICAgIGNvbnN0IG1lcCA9IHRvTnVtYmVyKHIubWVwKTsKICAgICAgY29uc3QgY2NsID0gdG9OdW1iZXIoci5jY2wpOwogICAgICBjb25zdCBhYnMgPSB0b051bWJlcihyLmFic19kaWZmKTsKICAgICAgY29uc3QgcGN0ID0gdG9OdW1iZXIoci5wY3RfZGlmZik7CiAgICAgIGNvbnN0IGVzdGFkbyA9IEJvb2xlYW4oci5zaW1pbGFyKSA/ICdTSU1JTEFSJyA6ICdOTyBTSU1JTEFSJzsKICAgICAgcmV0dXJuIFsKICAgICAgICBmbXRBcmdEYXlNb250aC5mb3JtYXQoZGF0ZSksCiAgICAgICAgZm10QXJnSG91ci5mb3JtYXQoZGF0ZSksCiAgICAgICAgY3N2TnVtYmVyKG1lcCwgMiksCiAgICAgICAgY3N2TnVtYmVyKGNjbCwgMiksCiAgICAgICAgY3N2TnVtYmVyKGFicywgMiksCiAgICAgICAgY3N2TnVtYmVyKHBjdCwgMiksCiAgICAgICAgZXN0YWRvCiAgICAgIF0ubWFwKGNzdkVzY2FwZSkuam9pbignOycpOwogICAgfSk7CiAgICBjb25zdCBhcnREYXRlID0gZm10QXJnRGF0ZS5mb3JtYXQobmV3IERhdGUoKSk7CiAgICBjb25zdCBmaWxlbmFtZSA9IGBoaXN0b3JpYWwtbWVwLWNjbC0ke2ZpbHRlckNvZGUoKX0tJHthcnREYXRlfS5jc3ZgOwogICAgY29uc3QgY3N2ID0gJ1x1RkVGRicgKyBbaGVhZGVyLmpvaW4oJzsnKSwgLi4ucm93c10uam9pbignXG4nKTsKICAgIGNvbnN0IGJsb2IgPSBuZXcgQmxvYihbY3N2XSwgeyB0eXBlOiAndGV4dC9jc3Y7Y2hhcnNldD11dGYtODsnIH0pOwogICAgY29uc3QgdXJsID0gVVJMLmNyZWF0ZU9iamVjdFVSTChibG9iKTsKICAgIGNvbnN0IGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdhJyk7CiAgICBhLmhyZWYgPSB1cmw7CiAgICBhLmRvd25sb2FkID0gZmlsZW5hbWU7CiAgICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKGEpOwogICAgYS5jbGljaygpOwogICAgYS5yZW1vdmUoKTsKICAgIFVSTC5yZXZva2VPYmplY3RVUkwodXJsKTsKICB9CiAgZnVuY3Rpb24gYXBwbHlGaWx0ZXIobW9kZSkgewogICAgc3RhdGUuZmlsdGVyTW9kZSA9IG1vZGU7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcucGlsbFtkYXRhLWZpbHRlcl0nKS5mb3JFYWNoKChidG4pID0+IHsKICAgICAgYnRuLmNsYXNzTGlzdC50b2dnbGUoJ29uJywgYnRuLmRhdGFzZXQuZmlsdGVyID09PSBtb2RlKTsKICAgIH0pOwogICAgaWYgKHN0YXRlLmxhc3RNZXBQYXlsb2FkKSB7CiAgICAgIHJlbmRlclRyZW5kKHN0YXRlLmxhc3RNZXBQYXlsb2FkKTsKICAgICAgcmVuZGVySGlzdG9yeShzdGF0ZS5sYXN0TWVwUGF5bG9hZCk7CiAgICAgIHJlbmRlck1ldHJpY3MyNGgoc3RhdGUubGFzdE1lcFBheWxvYWQpOwogICAgfQogIH0KCiAgZnVuY3Rpb24gcmVuZGVySGlzdG9yeShwYXlsb2FkKSB7CiAgICBjb25zdCB0Ym9keSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoaXN0b3J5LXJvd3MnKTsKICAgIGNvbnN0IGNhcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoaXN0b3J5LWNhcCcpOwogICAgaWYgKCF0Ym9keSkgcmV0dXJuOwogICAgY29uc3QgZmlsdGVyZWQgPSBnZXRGaWx0ZXJlZEhpc3RvcnlSb3dzKHBheWxvYWQpOwogICAgY29uc3Qgcm93cyA9IGZpbHRlcmVkLnNsaWNlKCkucmV2ZXJzZSgpOwogICAgaWYgKGNhcCkgY2FwLnRleHRDb250ZW50ID0gYCR7Y3VycmVudEZpbHRlckxhYmVsKCl9IMK3ICR7cm93cy5sZW5ndGh9IHJlZ2lzdHJvc2A7CiAgICBpZiAoIXJvd3MubGVuZ3RoKSB7CiAgICAgIHRib2R5LmlubmVySFRNTCA9ICc8dHI+PHRkIGNsYXNzPSJkaW0iIGNvbHNwYW49IjYiPlNpbiByZWdpc3Ryb3MgdG9kYXbDrWE8L3RkPjwvdHI+JzsKICAgICAgcmV0dXJuOwogICAgfQogICAgdGJvZHkuaW5uZXJIVE1MID0gcm93cy5tYXAoKHIpID0+IHsKICAgICAgY29uc3QgbWVwID0gdG9OdW1iZXIoci5tZXApOwogICAgICBjb25zdCBjY2wgPSB0b051bWJlcihyLmNjbCk7CiAgICAgIGNvbnN0IGFicyA9IHRvTnVtYmVyKHIuYWJzX2RpZmYpOwogICAgICBjb25zdCBwY3QgPSB0b051bWJlcihyLnBjdF9kaWZmKTsKICAgICAgY29uc3Qgc2ltID0gQm9vbGVhbihyLnNpbWlsYXIpOwogICAgICByZXR1cm4gYDx0cj4KICAgICAgICA8dGQgY2xhc3M9ImRpbSI+PGRpdiBjbGFzcz0idHMtZGF5Ij4ke2ZtdEFyZ0RheU1vbnRoLmZvcm1hdChuZXcgRGF0ZShyLmVwb2NoICogMTAwMCkpfTwvZGl2PjxkaXYgY2xhc3M9InRzLWhvdXIiPiR7cm93SG91ckxhYmVsKHIuZXBvY2gpfTwvZGl2PjwvdGQ+CiAgICAgICAgPHRkIHN0eWxlPSJjb2xvcjp2YXIoLS1tZXApIj4ke2Zvcm1hdE1vbmV5KG1lcCwgMil9PC90ZD4KICAgICAgICA8dGQgc3R5bGU9ImNvbG9yOnZhcigtLWNjbCkiPiR7Zm9ybWF0TW9uZXkoY2NsLCAyKX08L3RkPgogICAgICAgIDx0ZD4ke2Zvcm1hdE1vbmV5KGFicywgMil9PC90ZD4KICAgICAgICA8dGQ+JHtmb3JtYXRQZXJjZW50KHBjdCwgMil9PC90ZD4KICAgICAgICA8dGQ+PHNwYW4gY2xhc3M9InNiYWRnZSAke3NpbSA/ICdzaW0nIDogJ25vc2ltJ30iPiR7c2ltID8gJ1NpbWlsYXInIDogJ05vIHNpbWlsYXInfTwvc3Bhbj48L3RkPgogICAgICA8L3RyPmA7CiAgICB9KS5qb2luKCcnKTsKICB9CgogIGZ1bmN0aW9uIGxpbmVQb2ludHModmFsdWVzLCB4MCwgeDEsIHkwLCB5MSwgbWluVmFsdWUsIG1heFZhbHVlKSB7CiAgICBpZiAoIXZhbHVlcy5sZW5ndGgpIHJldHVybiAnJzsKICAgIGNvbnN0IG1pbiA9IE51bWJlci5pc0Zpbml0ZShtaW5WYWx1ZSkgPyBtaW5WYWx1ZSA6IE1hdGgubWluKC4uLnZhbHVlcyk7CiAgICBjb25zdCBtYXggPSBOdW1iZXIuaXNGaW5pdGUobWF4VmFsdWUpID8gbWF4VmFsdWUgOiBNYXRoLm1heCguLi52YWx1ZXMpOwogICAgY29uc3Qgc3BhbiA9IE1hdGgubWF4KDAuMDAwMDAxLCBtYXggLSBtaW4pOwogICAgcmV0dXJuIHZhbHVlcy5tYXAoKHYsIGkpID0+IHsKICAgICAgY29uc3QgeCA9IHgwICsgKCh4MSAtIHgwKSAqIGkgLyBNYXRoLm1heCgxLCB2YWx1ZXMubGVuZ3RoIC0gMSkpOwogICAgICBjb25zdCB5ID0geTEgLSAoKHYgLSBtaW4pIC8gc3BhbikgKiAoeTEgLSB5MCk7CiAgICAgIHJldHVybiBgJHt4LnRvRml4ZWQoMil9LCR7eS50b0ZpeGVkKDIpfWA7CiAgICB9KS5qb2luKCcgJyk7CiAgfQogIGZ1bmN0aW9uIHZhbHVlVG9ZKHZhbHVlLCB5MCwgeTEsIG1pblZhbHVlLCBtYXhWYWx1ZSkgewogICAgY29uc3Qgc3BhbiA9IE1hdGgubWF4KDAuMDAwMDAxLCBtYXhWYWx1ZSAtIG1pblZhbHVlKTsKICAgIHJldHVybiB5MSAtICgodmFsdWUgLSBtaW5WYWx1ZSkgLyBzcGFuKSAqICh5MSAtIHkwKTsKICB9CiAgZnVuY3Rpb24gY2FsY0JyZWNoYVBjdChtZXAsIGNjbCkgewogICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUobWVwKSB8fCAhTnVtYmVyLmlzRmluaXRlKGNjbCkpIHJldHVybiBudWxsOwogICAgY29uc3QgYXZnID0gKG1lcCArIGNjbCkgLyAyOwogICAgaWYgKCFhdmcpIHJldHVybiBudWxsOwogICAgcmV0dXJuIChNYXRoLmFicyhtZXAgLSBjY2wpIC8gYXZnKSAqIDEwMDsKICB9CiAgZnVuY3Rpb24gaGlkZVRyZW5kSG92ZXIoKSB7CiAgICBjb25zdCB0aXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtdG9vbHRpcCcpOwogICAgY29uc3QgbGluZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1ob3Zlci1saW5lJyk7CiAgICBjb25zdCBtZXBEb3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtaG92ZXItbWVwJyk7CiAgICBjb25zdCBjY2xEb3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtaG92ZXItY2NsJyk7CiAgICBpZiAodGlwKSB0aXAuc2V0QXR0cmlidXRlKCdvcGFjaXR5JywgJzAnKTsKICAgIGlmIChsaW5lKSBsaW5lLnNldEF0dHJpYnV0ZSgnb3BhY2l0eScsICcwJyk7CiAgICBpZiAobWVwRG90KSBtZXBEb3Quc2V0QXR0cmlidXRlKCdvcGFjaXR5JywgJzAnKTsKICAgIGlmIChjY2xEb3QpIGNjbERvdC5zZXRBdHRyaWJ1dGUoJ29wYWNpdHknLCAnMCcpOwogIH0KICBmdW5jdGlvbiByZW5kZXJUcmVuZEhvdmVyKHBvaW50KSB7CiAgICBjb25zdCB0aXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtdG9vbHRpcCcpOwogICAgY29uc3QgYmcgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtdG9vbHRpcC1iZycpOwogICAgY29uc3QgbGluZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1ob3Zlci1saW5lJyk7CiAgICBjb25zdCBtZXBEb3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtaG92ZXItbWVwJyk7CiAgICBjb25zdCBjY2xEb3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtaG92ZXItY2NsJyk7CiAgICBpZiAoIXRpcCB8fCAhYmcgfHwgIWxpbmUgfHwgIW1lcERvdCB8fCAhY2NsRG90IHx8ICFwb2ludCkgcmV0dXJuOwoKICAgIGxpbmUuc2V0QXR0cmlidXRlKCd4MScsIHBvaW50LngudG9GaXhlZCgyKSk7CiAgICBsaW5lLnNldEF0dHJpYnV0ZSgneDInLCBwb2ludC54LnRvRml4ZWQoMikpOwogICAgbGluZS5zZXRBdHRyaWJ1dGUoJ29wYWNpdHknLCAnMScpOwogICAgbWVwRG90LnNldEF0dHJpYnV0ZSgnY3gnLCBwb2ludC54LnRvRml4ZWQoMikpOwogICAgbWVwRG90LnNldEF0dHJpYnV0ZSgnY3knLCBwb2ludC5tZXBZLnRvRml4ZWQoMikpOwogICAgbWVwRG90LnNldEF0dHJpYnV0ZSgnb3BhY2l0eScsICcxJyk7CiAgICBjY2xEb3Quc2V0QXR0cmlidXRlKCdjeCcsIHBvaW50LngudG9GaXhlZCgyKSk7CiAgICBjY2xEb3Quc2V0QXR0cmlidXRlKCdjeScsIHBvaW50LmNjbFkudG9GaXhlZCgyKSk7CiAgICBjY2xEb3Quc2V0QXR0cmlidXRlKCdvcGFjaXR5JywgJzEnKTsKCiAgICBzZXRUZXh0KCd0cmVuZC10aXAtdGltZScsIHJvd0RheUhvdXJMYWJlbChwb2ludC5lcG9jaCkpOwogICAgc2V0VGV4dCgndHJlbmQtdGlwLW1lcCcsIGBNRVAgJHtmb3JtYXRNb25leShwb2ludC5tZXAsIDIpfWApOwogICAgc2V0VGV4dCgndHJlbmQtdGlwLWNjbCcsIGBDQ0wgJHtmb3JtYXRNb25leShwb2ludC5jY2wsIDIpfWApOwogICAgc2V0VGV4dCgndHJlbmQtdGlwLWdhcCcsIGBCcmVjaGEgJHtmb3JtYXRQZXJjZW50KHBvaW50LnBjdCwgMil9YCk7CgogICAgY29uc3QgdGlwVyA9IDE0ODsKICAgIGNvbnN0IHRpcEggPSA1NjsKICAgIGNvbnN0IHRpcFggPSBNYXRoLm1pbig4NDAgLSB0aXBXLCBNYXRoLm1heCgzMCwgcG9pbnQueCArIDEwKSk7CiAgICBjb25zdCB0aXBZID0gTWF0aC5taW4oMTAwLCBNYXRoLm1heCgxOCwgTWF0aC5taW4ocG9pbnQubWVwWSwgcG9pbnQuY2NsWSkgLSB0aXBIIC0gNCkpOwogICAgdGlwLnNldEF0dHJpYnV0ZSgndHJhbnNmb3JtJywgYHRyYW5zbGF0ZSgke3RpcFgudG9GaXhlZCgyKX0gJHt0aXBZLnRvRml4ZWQoMil9KWApOwogICAgYmcuc2V0QXR0cmlidXRlKCd3aWR0aCcsIFN0cmluZyh0aXBXKSk7CiAgICBiZy5zZXRBdHRyaWJ1dGUoJ2hlaWdodCcsIFN0cmluZyh0aXBIKSk7CiAgICB0aXAuc2V0QXR0cmlidXRlKCdvcGFjaXR5JywgJzEnKTsKICB9CiAgZnVuY3Rpb24gYmluZFRyZW5kSG92ZXIoKSB7CiAgICBpZiAoc3RhdGUudHJlbmRIb3ZlckJvdW5kKSByZXR1cm47CiAgICBjb25zdCBjaGFydCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1jaGFydCcpOwogICAgaWYgKCFjaGFydCkgcmV0dXJuOwogICAgc3RhdGUudHJlbmRIb3ZlckJvdW5kID0gdHJ1ZTsKCiAgICBjaGFydC5hZGRFdmVudExpc3RlbmVyKCdtb3VzZWxlYXZlJywgKCkgPT4gaGlkZVRyZW5kSG92ZXIoKSk7CiAgICBjaGFydC5hZGRFdmVudExpc3RlbmVyKCdtb3VzZW1vdmUnLCAoZXZlbnQpID0+IHsKICAgICAgaWYgKCFzdGF0ZS50cmVuZFJvd3MubGVuZ3RoKSByZXR1cm47CiAgICAgIGNvbnN0IGN0bSA9IGNoYXJ0LmdldFNjcmVlbkNUTSgpOwogICAgICBpZiAoIWN0bSkgcmV0dXJuOwogICAgICBjb25zdCBwdCA9IGNoYXJ0LmNyZWF0ZVNWR1BvaW50KCk7CiAgICAgIHB0LnggPSBldmVudC5jbGllbnRYOwogICAgICBwdC55ID0gZXZlbnQuY2xpZW50WTsKICAgICAgY29uc3QgbG9jYWwgPSBwdC5tYXRyaXhUcmFuc2Zvcm0oY3RtLmludmVyc2UoKSk7CiAgICAgIGNvbnN0IHggPSBNYXRoLm1heCgzMCwgTWF0aC5taW4oODQwLCBsb2NhbC54KSk7CiAgICAgIGxldCBuZWFyZXN0ID0gc3RhdGUudHJlbmRSb3dzWzBdOwogICAgICBsZXQgYmVzdCA9IE1hdGguYWJzKG5lYXJlc3QueCAtIHgpOwogICAgICBmb3IgKGxldCBpID0gMTsgaSA8IHN0YXRlLnRyZW5kUm93cy5sZW5ndGg7IGkrKykgewogICAgICAgIGNvbnN0IGQgPSBNYXRoLmFicyhzdGF0ZS50cmVuZFJvd3NbaV0ueCAtIHgpOwogICAgICAgIGlmIChkIDwgYmVzdCkgewogICAgICAgICAgYmVzdCA9IGQ7CiAgICAgICAgICBuZWFyZXN0ID0gc3RhdGUudHJlbmRSb3dzW2ldOwogICAgICAgIH0KICAgICAgfQogICAgICByZW5kZXJUcmVuZEhvdmVyKG5lYXJlc3QpOwogICAgfSk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJUcmVuZChwYXlsb2FkKSB7CiAgICBjb25zdCBoaXN0b3J5ID0gZG93bnNhbXBsZVJvd3MoZmlsdGVySGlzdG9yeVJvd3MoZXh0cmFjdEhpc3RvcnlSb3dzKHBheWxvYWQpLCBzdGF0ZS5maWx0ZXJNb2RlKSwgVFJFTkRfTUFYX1BPSU5UUyk7CiAgICBjb25zdCBtZXBMaW5lID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLW1lcC1saW5lJyk7CiAgICBjb25zdCBjY2xMaW5lID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLWNjbC1saW5lJyk7CiAgICBpZiAoIW1lcExpbmUgfHwgIWNjbExpbmUpIHJldHVybjsKICAgIGJpbmRUcmVuZEhvdmVyKCk7CiAgICBpZiAoIWhpc3RvcnkubGVuZ3RoKSB7CiAgICAgIG1lcExpbmUuc2V0QXR0cmlidXRlKCdwb2ludHMnLCAnJyk7CiAgICAgIGNjbExpbmUuc2V0QXR0cmlidXRlKCdwb2ludHMnLCAnJyk7CiAgICAgIHN0YXRlLnRyZW5kUm93cyA9IFtdOwogICAgICBoaWRlVHJlbmRIb3ZlcigpOwogICAgICBbJ3RyZW5kLXktdG9wJywgJ3RyZW5kLXktbWlkJywgJ3RyZW5kLXktbG93JywgJ3RyZW5kLXgtMScsICd0cmVuZC14LTInLCAndHJlbmQteC0zJywgJ3RyZW5kLXgtNCcsICd0cmVuZC14LTUnXS5mb3JFYWNoKChpZCkgPT4gc2V0VGV4dChpZCwgJ+KAlCcpKTsKICAgICAgcmV0dXJuOwogICAgfQoKICAgIGNvbnN0IHJvd3MgPSBoaXN0b3J5CiAgICAgIC5tYXAoKHIpID0+ICh7CiAgICAgICAgZXBvY2g6IHIuZXBvY2gsCiAgICAgICAgbWVwOiB0b051bWJlcihyLm1lcCksCiAgICAgICAgY2NsOiB0b051bWJlcihyLmNjbCksCiAgICAgICAgcGN0OiB0b051bWJlcihyLnBjdF9kaWZmKQogICAgICB9KSkKICAgICAgLmZpbHRlcigocikgPT4gci5tZXAgIT0gbnVsbCAmJiByLmNjbCAhPSBudWxsKTsKICAgIGlmICghcm93cy5sZW5ndGgpIHJldHVybjsKCiAgICBjb25zdCBtZXBWYWxzID0gcm93cy5tYXAoKHIpID0+IHIubWVwKTsKICAgIGNvbnN0IGNjbFZhbHMgPSByb3dzLm1hcCgocikgPT4gci5jY2wpOwoKICAgIC8vIEVzY2FsYSBjb21wYXJ0aWRhIHBhcmEgTUVQIHkgQ0NMOiBjb21wYXJhY2nDs24gdmlzdWFsIGZpZWwuCiAgICBjb25zdCBhbGxQcmljZVZhbHMgPSBtZXBWYWxzLmNvbmNhdChjY2xWYWxzKTsKICAgIGNvbnN0IHJhd01pbiA9IE1hdGgubWluKC4uLmFsbFByaWNlVmFscyk7CiAgICBjb25zdCByYXdNYXggPSBNYXRoLm1heCguLi5hbGxQcmljZVZhbHMpOwogICAgY29uc3QgcHJpY2VQYWQgPSBNYXRoLm1heCgxLCAocmF3TWF4IC0gcmF3TWluKSAqIDAuMDgpOwogICAgY29uc3QgcHJpY2VNaW4gPSByYXdNaW4gLSBwcmljZVBhZDsKICAgIGNvbnN0IHByaWNlTWF4ID0gcmF3TWF4ICsgcHJpY2VQYWQ7CgogICAgbWVwTGluZS5zZXRBdHRyaWJ1dGUoJ3BvaW50cycsIGxpbmVQb2ludHMobWVwVmFscywgMzAsIDg0MCwgMjUsIDEzMCwgcHJpY2VNaW4sIHByaWNlTWF4KSk7CiAgICBjY2xMaW5lLnNldEF0dHJpYnV0ZSgncG9pbnRzJywgbGluZVBvaW50cyhjY2xWYWxzLCAzMCwgODQwLCAyNSwgMTMwLCBwcmljZU1pbiwgcHJpY2VNYXgpKTsKICAgIHN0YXRlLnRyZW5kUm93cyA9IHJvd3MubWFwKChyLCBpKSA9PiB7CiAgICAgIGNvbnN0IHggPSAzMCArICgoODQwIC0gMzApICogaSAvIE1hdGgubWF4KDEsIHJvd3MubGVuZ3RoIC0gMSkpOwogICAgICByZXR1cm4gewogICAgICAgIGVwb2NoOiByLmVwb2NoLAogICAgICAgIG1lcDogci5tZXAsCiAgICAgICAgY2NsOiByLmNjbCwKICAgICAgICBwY3Q6IGNhbGNCcmVjaGFQY3Qoci5tZXAsIHIuY2NsKSwKICAgICAgICB4LAogICAgICAgIG1lcFk6IHZhbHVlVG9ZKHIubWVwLCAyNSwgMTMwLCBwcmljZU1pbiwgcHJpY2VNYXgpLAogICAgICAgIGNjbFk6IHZhbHVlVG9ZKHIuY2NsLCAyNSwgMTMwLCBwcmljZU1pbiwgcHJpY2VNYXgpCiAgICAgIH07CiAgICB9KTsKICAgIGhpZGVUcmVuZEhvdmVyKCk7CgogICAgY29uc3QgbWlkID0gKHByaWNlTWluICsgcHJpY2VNYXgpIC8gMjsKICAgIHNldFRleHQoJ3RyZW5kLXktdG9wJywgKHByaWNlTWF4IC8gMTAwMCkudG9GaXhlZCgzKSk7CiAgICBzZXRUZXh0KCd0cmVuZC15LW1pZCcsIChtaWQgLyAxMDAwKS50b0ZpeGVkKDMpKTsKICAgIHNldFRleHQoJ3RyZW5kLXktbG93JywgKHByaWNlTWluIC8gMTAwMCkudG9GaXhlZCgzKSk7CgogICAgY29uc3QgaWR4ID0gWzAsIDAuMjUsIDAuNSwgMC43NSwgMV0ubWFwKChwKSA9PiBNYXRoLm1pbihyb3dzLmxlbmd0aCAtIDEsIE1hdGguZmxvb3IoKHJvd3MubGVuZ3RoIC0gMSkgKiBwKSkpOwogICAgY29uc3QgbGFicyA9IGlkeC5tYXAoKGkpID0+IHJvd0RheUhvdXJMYWJlbChyb3dzW2ldPy5lcG9jaCkpOwogICAgc2V0VGV4dCgndHJlbmQteC0xJywgbGFic1swXSB8fCAn4oCUJyk7CiAgICBzZXRUZXh0KCd0cmVuZC14LTInLCBsYWJzWzFdIHx8ICfigJQnKTsKICAgIHNldFRleHQoJ3RyZW5kLXgtMycsIGxhYnNbMl0gfHwgJ+KAlCcpOwogICAgc2V0VGV4dCgndHJlbmQteC00JywgbGFic1szXSB8fCAn4oCUJyk7CiAgICBzZXRUZXh0KCd0cmVuZC14LTUnLCBsYWJzWzRdIHx8ICfigJQnKTsKICB9CgogIC8vIDQpIEZ1bmNpw7NuIGNlbnRyYWwgZmV0Y2hBbGwoKQogIGFzeW5jIGZ1bmN0aW9uIGZldGNoSnNvbih1cmwpIHsKICAgIGNvbnN0IGN0cmwgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7CiAgICBjb25zdCB0aW1lb3V0ID0gc2V0VGltZW91dCgoKSA9PiBjdHJsLmFib3J0KCksIDEyMDAwKTsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKHVybCwgeyBjYWNoZTogJ25vLXN0b3JlJywgc2lnbmFsOiBjdHJsLnNpZ25hbCB9KTsKICAgICAgaWYgKCFyZXMub2spIHRocm93IG5ldyBFcnJvcihgSFRUUCAke3Jlcy5zdGF0dXN9YCk7CiAgICAgIHJldHVybiBhd2FpdCByZXMuanNvbigpOwogICAgfSBmaW5hbGx5IHsKICAgICAgY2xlYXJUaW1lb3V0KHRpbWVvdXQpOwogICAgfQogIH0KCiAgYXN5bmMgZnVuY3Rpb24gZmV0Y2hBbGwob3B0aW9ucyA9IHt9KSB7CiAgICBpZiAoc3RhdGUuaXNGZXRjaGluZykgcmV0dXJuOwogICAgc3RhdGUuaXNGZXRjaGluZyA9IHRydWU7CiAgICBzZXRMb2FkaW5nKE5VTUVSSUNfSURTLCB0cnVlKTsKICAgIHNldEZyZXNoQmFkZ2UoJ0FjdHVhbGl6YW5kb+KApicsICdmZXRjaGluZycpOwogICAgc2V0RXJyb3JCYW5uZXIoZmFsc2UpOwogICAgdHJ5IHsKICAgICAgY29uc3QgdGFza3MgPSBbCiAgICAgICAgWydtZXBDY2wnLCBFTkRQT0lOVFMubWVwQ2NsXQogICAgICBdOwoKICAgICAgY29uc3Qgc2V0dGxlZCA9IGF3YWl0IFByb21pc2UuYWxsU2V0dGxlZCh0YXNrcy5tYXAoYXN5bmMgKFtuYW1lLCB1cmxdKSA9PiB7CiAgICAgICAgdHJ5IHsKICAgICAgICAgIGNvbnN0IGRhdGEgPSBhd2FpdCBmZXRjaEpzb24odXJsKTsKICAgICAgICAgIHJldHVybiB7IG5hbWUsIGRhdGEgfTsKICAgICAgICB9IGNhdGNoIChlcnJvcikgewogICAgICAgICAgY29uc29sZS5lcnJvcihgW1JhZGFyTUVQXSBlcnJvciBlbiAke25hbWV9YCwgZXJyb3IpOwogICAgICAgICAgdGhyb3cgeyBuYW1lLCBlcnJvciB9OwogICAgICAgIH0KICAgICAgfSkpOwoKICAgICAgY29uc3QgYmFnID0geyB0aW1lc3RhbXA6IERhdGUubm93KCksIG1lcENjbDogbnVsbCB9OwogICAgICBjb25zdCBmYWlsZWQgPSBbXTsKICAgICAgc2V0dGxlZC5mb3JFYWNoKChyLCBpZHgpID0+IHsKICAgICAgICBjb25zdCBuYW1lID0gdGFza3NbaWR4XVswXTsKICAgICAgICBpZiAoci5zdGF0dXMgPT09ICdmdWxmaWxsZWQnKSBiYWdbbmFtZV0gPSByLnZhbHVlLmRhdGE7CiAgICAgICAgZWxzZSBmYWlsZWQucHVzaChuYW1lKTsKICAgICAgfSk7CgogICAgICByZW5kZXJNZXBDY2woYmFnLm1lcENjbCk7CiAgICAgIHN0YXRlLmxhc3RNZXBQYXlsb2FkID0gYmFnLm1lcENjbDsKICAgICAgcmVuZGVyTWV0cmljczI0aChiYWcubWVwQ2NsKTsKICAgICAgcmVuZGVyVHJlbmQoYmFnLm1lcENjbCk7CiAgICAgIHJlbmRlckhpc3RvcnkoYmFnLm1lcENjbCk7CiAgICAgIGNvbnN0IG1lcFJvb3QgPSBleHRyYWN0Um9vdChiYWcubWVwQ2NsKTsKICAgICAgY29uc3QgdXBkYXRlZEFydCA9IHR5cGVvZiBtZXBSb290Py51cGRhdGVkQXRIdW1hbkFydCA9PT0gJ3N0cmluZycgPyBtZXBSb290LnVwZGF0ZWRBdEh1bWFuQXJ0IDogbnVsbDsKICAgICAgY29uc3Qgc291cmNlVHNNcyA9IHRvTnVtYmVyKG1lcFJvb3Q/LnNvdXJjZVN0YXR1cz8ubGF0ZXN0U291cmNlVHNNcykKICAgICAgICA/PyB0b051bWJlcihtZXBSb290Py5jdXJyZW50Py5tZXBUc01zKQogICAgICAgID8/IHRvTnVtYmVyKG1lcFJvb3Q/LmN1cnJlbnQ/LmNjbFRzTXMpCiAgICAgICAgPz8gbnVsbDsKICAgICAgc3RhdGUuc291cmNlVHNNcyA9IHNvdXJjZVRzTXM7CiAgICAgIHNldFRleHQoJ2xhc3QtcnVuLXRpbWUnLCB1cGRhdGVkQXJ0IHx8IGZtdEFyZ1RpbWVTZWMuZm9ybWF0KG5ldyBEYXRlKCkpKTsKCiAgICAgIGNvbnN0IHN1Y2Nlc3NDb3VudCA9IHRhc2tzLmxlbmd0aCAtIGZhaWxlZC5sZW5ndGg7CiAgICAgIGlmIChzdWNjZXNzQ291bnQgPiAwKSB7CiAgICAgICAgc3RhdGUubGFzdFN1Y2Nlc3NBdCA9IERhdGUubm93KCk7CiAgICAgICAgc3RhdGUucmV0cnlJbmRleCA9IDA7CiAgICAgICAgaWYgKHN0YXRlLnJldHJ5VGltZXIpIGNsZWFyVGltZW91dChzdGF0ZS5yZXRyeVRpbWVyKTsKICAgICAgICBzYXZlQ2FjaGUoYmFnKTsKICAgICAgICBjb25zdCBhZ2VMYWJlbCA9IHNvdXJjZVRzTXMgIT0gbnVsbCA/IGZvcm1hdFNvdXJjZUFnZUxhYmVsKHNvdXJjZVRzTXMpIDogbnVsbDsKICAgICAgICBjb25zdCBiYWRnZUJhc2UgPSBhZ2VMYWJlbCA/IGDDmmx0aW1hIGFjdHVhbGl6YWNpw7NuIGhhY2U6ICR7YWdlTGFiZWx9YCA6IGBBY3R1YWxpemFkbyDCtyAke2ZtdEFyZ1RpbWUuZm9ybWF0KG5ldyBEYXRlKCkpfWA7CiAgICAgICAgaWYgKGZhaWxlZC5sZW5ndGgpIHNldEZyZXNoQmFkZ2UoYEFjdHVhbGl6YWNpw7NuIHBhcmNpYWwgwrcgJHtiYWRnZUJhc2V9YCwgJ2lkbGUnKTsKICAgICAgICBlbHNlIHNldEZyZXNoQmFkZ2UoYmFkZ2VCYXNlLCAnaWRsZScpOwogICAgICAgIHJlZnJlc2hGcmVzaEJhZGdlRnJvbVNvdXJjZSgpOwogICAgICB9IGVsc2UgewogICAgICAgIGNvbnN0IGF0dGVtcHQgPSBzdGF0ZS5yZXRyeUluZGV4ICsgMTsKICAgICAgICBpZiAoc3RhdGUucmV0cnlJbmRleCA8IFJFVFJZX0RFTEFZUy5sZW5ndGgpIHsKICAgICAgICAgIGNvbnN0IGRlbGF5ID0gUkVUUllfREVMQVlTW3N0YXRlLnJldHJ5SW5kZXhdOwogICAgICAgICAgc3RhdGUucmV0cnlJbmRleCArPSAxOwogICAgICAgICAgc2V0RnJlc2hCYWRnZShgRXJyb3IgwrcgUmVpbnRlbnRvIGVuICR7TWF0aC5yb3VuZChkZWxheSAvIDEwMDApfXNgLCAnZXJyb3InKTsKICAgICAgICAgIGlmIChzdGF0ZS5yZXRyeVRpbWVyKSBjbGVhclRpbWVvdXQoc3RhdGUucmV0cnlUaW1lcik7CiAgICAgICAgICBzdGF0ZS5yZXRyeVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBmZXRjaEFsbCh7IG1hbnVhbDogdHJ1ZSB9KSwgZGVsYXkpOwogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICBzZXRGcmVzaEJhZGdlKCdFcnJvciDCtyBSZWludGVudGFyJywgJ2Vycm9yJyk7CiAgICAgICAgICBzZXRFcnJvckJhbm5lcih0cnVlLCAnRXJyb3IgYWwgYWN0dWFsaXphciDCtyBSZWludGVudGFyJyk7CiAgICAgICAgICBjb25zb2xlLmVycm9yKGBbUmFkYXJNRVBdIHNlIGFnb3Rhcm9uIHJldHJpZXMgKCR7YXR0ZW1wdH0gaW50ZW50b3MpYCk7CiAgICAgICAgICBpZiAod2luZG93LnNjaGVkdWxlcikgd2luZG93LnNjaGVkdWxlci5zdG9wKCk7CiAgICAgICAgfQogICAgICB9CiAgICB9IGZpbmFsbHkgewogICAgICBzZXRMb2FkaW5nKE5VTUVSSUNfSURTLCBmYWxzZSk7CiAgICAgIHN0YXRlLmlzRmV0Y2hpbmcgPSBmYWxzZTsKICAgIH0KICB9CgogIC8vIDUpIENsYXNlIE1hcmtldFNjaGVkdWxlcgogIGNsYXNzIE1hcmtldFNjaGVkdWxlciB7CiAgICBjb25zdHJ1Y3RvcihmZXRjaEZuLCBpbnRlcnZhbE1zID0gMzAwMDAwKSB7CiAgICAgIHRoaXMuZmV0Y2hGbiA9IGZldGNoRm47CiAgICAgIHRoaXMuaW50ZXJ2YWxNcyA9IGludGVydmFsTXM7CiAgICAgIHRoaXMudGltZXIgPSBudWxsOwogICAgICB0aGlzLndhaXRUaW1lciA9IG51bGw7CiAgICAgIHRoaXMuY291bnRkb3duVGltZXIgPSBudWxsOwogICAgICB0aGlzLm5leHRSdW5BdCA9IG51bGw7CiAgICAgIHRoaXMucnVubmluZyA9IGZhbHNlOwogICAgICB0aGlzLnBhdXNlZCA9IGZhbHNlOwogICAgfQoKICAgIHN0YXJ0KCkgewogICAgICBpZiAodGhpcy5ydW5uaW5nKSByZXR1cm47CiAgICAgIHRoaXMucnVubmluZyA9IHRydWU7CiAgICAgIHRoaXMucGF1c2VkID0gZmFsc2U7CiAgICAgIGlmICh0aGlzLmlzTWFya2V0T3BlbigpKSB7CiAgICAgICAgc2V0TWFya2V0VGFnKHRydWUpOwogICAgICAgIHRoaXMuX3NjaGVkdWxlKHRoaXMuaW50ZXJ2YWxNcyk7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgc2V0TWFya2V0VGFnKGZhbHNlKTsKICAgICAgICB0aGlzLl93YWl0Rm9yT3BlbigpOwogICAgICB9CiAgICAgIHRoaXMuX3N0YXJ0Q291bnRkb3duKCk7CiAgICB9CgogICAgcGF1c2UoKSB7CiAgICAgIHRoaXMucGF1c2VkID0gdHJ1ZTsKICAgICAgY2xlYXJUaW1lb3V0KHRoaXMudGltZXIpOwogICAgICBjbGVhclRpbWVvdXQodGhpcy53YWl0VGltZXIpOwogICAgICB0aGlzLnRpbWVyID0gbnVsbDsKICAgICAgdGhpcy53YWl0VGltZXIgPSBudWxsOwogICAgICB0aGlzLl9zdG9wQ291bnRkb3duKCk7CiAgICAgIGNvbnN0IGNvdW50ZG93biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb3VudGRvd24tdGV4dCcpOwogICAgICBpZiAoY291bnRkb3duKSBjb3VudGRvd24udGV4dENvbnRlbnQgPSAnQWN0dWFsaXphY2nDs24gcGF1c2FkYSc7CiAgICB9CgogICAgcmVzdW1lKCkgewogICAgICBpZiAoIXRoaXMucnVubmluZykgdGhpcy5ydW5uaW5nID0gdHJ1ZTsKICAgICAgdGhpcy5wYXVzZWQgPSBmYWxzZTsKICAgICAgY29uc3QgY29udGludWVSZXN1bWUgPSAoKSA9PiB7CiAgICAgICAgaWYgKHRoaXMuaXNNYXJrZXRPcGVuKCkpIHsKICAgICAgICAgIHNldE1hcmtldFRhZyh0cnVlKTsKICAgICAgICAgIHRoaXMuX3NjaGVkdWxlKHRoaXMuaW50ZXJ2YWxNcyk7CiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgIHNldE1hcmtldFRhZyhmYWxzZSk7CiAgICAgICAgICB0aGlzLl93YWl0Rm9yT3BlbigpOwogICAgICAgIH0KICAgICAgICB0aGlzLl9zdGFydENvdW50ZG93bigpOwogICAgICB9OwogICAgICBpZiAoRGF0ZS5ub3coKSAtIHN0YXRlLmxhc3RTdWNjZXNzQXQgPiB0aGlzLmludGVydmFsTXMpIHsKICAgICAgICBQcm9taXNlLnJlc29sdmUodGhpcy5mZXRjaEZuKHsgbWFudWFsOiB0cnVlIH0pKS5maW5hbGx5KGNvbnRpbnVlUmVzdW1lKTsKICAgICAgfSBlbHNlIHsKICAgICAgICBjb250aW51ZVJlc3VtZSgpOwogICAgICB9CiAgICB9CgogICAgc3RvcCgpIHsKICAgICAgdGhpcy5ydW5uaW5nID0gZmFsc2U7CiAgICAgIHRoaXMucGF1c2VkID0gZmFsc2U7CiAgICAgIGNsZWFyVGltZW91dCh0aGlzLnRpbWVyKTsKICAgICAgY2xlYXJUaW1lb3V0KHRoaXMud2FpdFRpbWVyKTsKICAgICAgdGhpcy50aW1lciA9IG51bGw7CiAgICAgIHRoaXMud2FpdFRpbWVyID0gbnVsbDsKICAgICAgdGhpcy5uZXh0UnVuQXQgPSBudWxsOwogICAgICB0aGlzLl9zdG9wQ291bnRkb3duKCk7CiAgICB9CgogICAgaXNNYXJrZXRPcGVuKCkgewogICAgICBjb25zdCBwID0gZ2V0QXJnTm93UGFydHMoKTsKICAgICAgY29uc3QgYnVzaW5lc3NEYXkgPSBwLndlZWtkYXkgPj0gMSAmJiBwLndlZWtkYXkgPD0gNTsKICAgICAgY29uc3Qgc2Vjb25kcyA9IHAuaG91ciAqIDM2MDAgKyBwLm1pbnV0ZSAqIDYwICsgcC5zZWNvbmQ7CiAgICAgIGNvbnN0IGZyb20gPSAxMCAqIDM2MDAgKyAzMCAqIDYwOwogICAgICBjb25zdCB0byA9IDE4ICogMzYwMDsKICAgICAgcmV0dXJuIGJ1c2luZXNzRGF5ICYmIHNlY29uZHMgPj0gZnJvbSAmJiBzZWNvbmRzIDwgdG87CiAgICB9CgogICAgZ2V0TmV4dFJ1blRpbWUoKSB7CiAgICAgIHJldHVybiB0aGlzLm5leHRSdW5BdCA/IG5ldyBEYXRlKHRoaXMubmV4dFJ1bkF0KSA6IG51bGw7CiAgICB9CgogICAgX3NjaGVkdWxlKGRlbGF5TXMpIHsKICAgICAgaWYgKCF0aGlzLnJ1bm5pbmcgfHwgdGhpcy5wYXVzZWQpIHJldHVybjsKICAgICAgY2xlYXJUaW1lb3V0KHRoaXMudGltZXIpOwogICAgICB0aGlzLm5leHRSdW5BdCA9IERhdGUubm93KCkgKyBkZWxheU1zOwogICAgICB0aGlzLnRpbWVyID0gc2V0VGltZW91dChhc3luYyAoKSA9PiB7CiAgICAgICAgaWYgKCF0aGlzLnJ1bm5pbmcgfHwgdGhpcy5wYXVzZWQpIHJldHVybjsKICAgICAgICBpZiAoIXRoaXMuaXNNYXJrZXRPcGVuKCkpIHsKICAgICAgICAgIHNldE1hcmtldFRhZyhmYWxzZSk7CiAgICAgICAgICB0aGlzLl93YWl0Rm9yT3BlbigpOwogICAgICAgICAgcmV0dXJuOwogICAgICAgIH0KICAgICAgICBzZXRNYXJrZXRUYWcodHJ1ZSk7CiAgICAgICAgYXdhaXQgdGhpcy5mZXRjaEZuKCk7CiAgICAgICAgdGhpcy5fc2NoZWR1bGUodGhpcy5pbnRlcnZhbE1zKTsKICAgICAgfSwgZGVsYXlNcyk7CiAgICB9CgogICAgX3dhaXRGb3JPcGVuKCkgewogICAgICBpZiAoIXRoaXMucnVubmluZyB8fCB0aGlzLnBhdXNlZCkgcmV0dXJuOwogICAgICBjbGVhclRpbWVvdXQodGhpcy53YWl0VGltZXIpOwogICAgICB0aGlzLm5leHRSdW5BdCA9IERhdGUubm93KCkgKyA2MDAwMDsKICAgICAgdGhpcy53YWl0VGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHsKICAgICAgICBpZiAoIXRoaXMucnVubmluZyB8fCB0aGlzLnBhdXNlZCkgcmV0dXJuOwogICAgICAgIGlmICh0aGlzLmlzTWFya2V0T3BlbigpKSB7CiAgICAgICAgICBzZXRNYXJrZXRUYWcodHJ1ZSk7CiAgICAgICAgICB0aGlzLmZldGNoRm4oeyBtYW51YWw6IHRydWUgfSk7CiAgICAgICAgICB0aGlzLl9zY2hlZHVsZSh0aGlzLmludGVydmFsTXMpOwogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICBzZXRNYXJrZXRUYWcoZmFsc2UpOwogICAgICAgICAgdGhpcy5fd2FpdEZvck9wZW4oKTsKICAgICAgICB9CiAgICAgIH0sIDYwMDAwKTsKICAgIH0KCiAgICBfc3RhcnRDb3VudGRvd24oKSB7CiAgICAgIHRoaXMuX3N0b3BDb3VudGRvd24oKTsKICAgICAgdGhpcy5jb3VudGRvd25UaW1lciA9IHNldEludGVydmFsKCgpID0+IHsKICAgICAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb3VudGRvd24tdGV4dCcpOwogICAgICAgIGlmICghZWwgfHwgdGhpcy5wYXVzZWQpIHJldHVybjsKICAgICAgICBjb25zdCBuZXh0ID0gdGhpcy5nZXROZXh0UnVuVGltZSgpOwogICAgICAgIGlmICghbmV4dCkgewogICAgICAgICAgZWwudGV4dENvbnRlbnQgPSB0aGlzLmlzTWFya2V0T3BlbigpID8gJ1Byw7N4aW1hIGFjdHVhbGl6YWNpw7NuIGVuIOKAlCcgOiAnTWVyY2FkbyBjZXJyYWRvJzsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgICAgY29uc3QgZGlmZiA9IE1hdGgubWF4KDAsIG5leHQuZ2V0VGltZSgpIC0gRGF0ZS5ub3coKSk7CiAgICAgICAgY29uc3QgbSA9IE1hdGguZmxvb3IoZGlmZiAvIDYwMDAwKTsKICAgICAgICBjb25zdCBzID0gTWF0aC5mbG9vcigoZGlmZiAlIDYwMDAwKSAvIDEwMDApOwogICAgICAgIGlmICh0aGlzLmlzTWFya2V0T3BlbigpKSBlbC50ZXh0Q29udGVudCA9IGBQcsOzeGltYSBhY3R1YWxpemFjacOzbiBlbiAke219OiR7U3RyaW5nKHMpLnBhZFN0YXJ0KDIsICcwJyl9YDsKICAgICAgICBlbHNlIGVsLnRleHRDb250ZW50ID0gJ01lcmNhZG8gY2VycmFkbyc7CiAgICAgIH0sIDEwMDApOwogICAgfQoKICAgIF9zdG9wQ291bnRkb3duKCkgewogICAgICBjbGVhckludGVydmFsKHRoaXMuY291bnRkb3duVGltZXIpOwogICAgICB0aGlzLmNvdW50ZG93blRpbWVyID0gbnVsbDsKICAgIH0KICB9CgogIC8vIDYpIEzDs2dpY2EgZGUgY2FjaMOpCiAgZnVuY3Rpb24gc2F2ZUNhY2hlKGRhdGEpIHsKICAgIHRyeSB7CiAgICAgIHNlc3Npb25TdG9yYWdlLnNldEl0ZW0oQ0FDSEVfS0VZLCBKU09OLnN0cmluZ2lmeSh7CiAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLAogICAgICAgIG1lcENjbDogZGF0YS5tZXBDY2wKICAgICAgfSkpOwogICAgfSBjYXRjaCAoZSkgewogICAgICBjb25zb2xlLmVycm9yKCdbUmFkYXJNRVBdIG5vIHNlIHB1ZG8gZ3VhcmRhciBjYWNoZScsIGUpOwogICAgfQogIH0KCiAgZnVuY3Rpb24gbG9hZENhY2hlKCkgewogICAgdHJ5IHsKICAgICAgY29uc3QgcmF3ID0gc2Vzc2lvblN0b3JhZ2UuZ2V0SXRlbShDQUNIRV9LRVkpOwogICAgICBpZiAoIXJhdykgcmV0dXJuIG51bGw7CiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KTsKICAgICAgaWYgKCFwYXJzZWQudGltZXN0YW1wIHx8IERhdGUubm93KCkgLSBwYXJzZWQudGltZXN0YW1wID4gQ0FDSEVfVFRMX01TKSByZXR1cm4gbnVsbDsKICAgICAgcmV0dXJuIHBhcnNlZDsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgY29uc29sZS5lcnJvcignW1JhZGFyTUVQXSBjYWNoZSBpbnbDoWxpZGEnLCBlKTsKICAgICAgcmV0dXJuIG51bGw7CiAgICB9CiAgfQoKICAvLyA3KSBJbmljaWFsaXphY2nDs24KICBzdGFydEZyZXNoVGlja2VyKCk7CiAgZnVuY3Rpb24gdG9nZ2xlRHJhd2VyKCkgewogICAgY29uc3QgZHJhd2VyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2RyYXdlcicpOwogICAgY29uc3Qgd3JhcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdib2R5V3JhcCcpOwogICAgY29uc3QgYnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2J0blRhc2FzJyk7CiAgICBjb25zdCBvdmwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnb3ZlcmxheScpOwogICAgY29uc3QgaXNPcGVuID0gZHJhd2VyLmNsYXNzTGlzdC5jb250YWlucygnb3BlbicpOwogICAgZHJhd2VyLmNsYXNzTGlzdC50b2dnbGUoJ29wZW4nLCAhaXNPcGVuKTsKICAgIHdyYXAuY2xhc3NMaXN0LnRvZ2dsZSgnZHJhd2VyLW9wZW4nLCAhaXNPcGVuKTsKICAgIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKCdhY3RpdmUnLCAhaXNPcGVuKTsKICAgIG92bC5jbGFzc0xpc3QudG9nZ2xlKCdzaG93JywgIWlzT3Blbik7CiAgfQoKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcucGlsbFtkYXRhLWZpbHRlcl0nKS5mb3JFYWNoKChwKSA9PiB7CiAgICBwLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gYXBwbHlGaWx0ZXIocC5kYXRhc2V0LmZpbHRlcikpOwogIH0pOwogIGNvbnN0IGNzdkJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdidG4tZG93bmxvYWQtY3N2Jyk7CiAgaWYgKGNzdkJ0bikgY3N2QnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgZG93bmxvYWRIaXN0b3J5Q3N2KTsKCiAgZnVuY3Rpb24gdG9nZ2xlR2xvcygpIHsKICAgIGNvbnN0IGdyaWQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZ2xvc0dyaWQnKTsKICAgIGNvbnN0IGFycm93ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2dsb3NBcnJvdycpOwogICAgY29uc3Qgb3BlbiA9IGdyaWQuY2xhc3NMaXN0LnRvZ2dsZSgnb3BlbicpOwogICAgYXJyb3cudGV4dENvbnRlbnQgPSBvcGVuID8gJ+KWtCcgOiAn4pa+JzsKICB9CgogIGNvbnN0IHJldHJ5QnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Vycm9yLXJldHJ5LWJ0bicpOwogIGlmIChyZXRyeUJ0bikgewogICAgcmV0cnlCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgIGlmICh3aW5kb3cuc2NoZWR1bGVyKSB3aW5kb3cuc2NoZWR1bGVyLnJlc3VtZSgpOwogICAgICBmZXRjaEFsbCh7IG1hbnVhbDogdHJ1ZSB9KTsKICAgIH0pOwogIH0KCiAgY29uc3QgY2FjaGVkID0gbG9hZENhY2hlKCk7CiAgaW5pdEhpc3RvcnlDb2x1bW5XaWR0aHMoKTsKICBiaW5kSGlzdG9yeUNvbHVtblJlc2l6ZSgpOwogIGlmIChjYWNoZWQpIHsKICAgIHN0YXRlLmxhc3RNZXBQYXlsb2FkID0gY2FjaGVkLm1lcENjbDsKICAgIHJlbmRlck1lcENjbChjYWNoZWQubWVwQ2NsKTsKICAgIHJlbmRlck1ldHJpY3MyNGgoY2FjaGVkLm1lcENjbCk7CiAgICByZW5kZXJUcmVuZChjYWNoZWQubWVwQ2NsKTsKICAgIHJlbmRlckhpc3RvcnkoY2FjaGVkLm1lcENjbCk7CiAgICBjb25zdCBjYWNoZWRSb290ID0gZXh0cmFjdFJvb3QoY2FjaGVkLm1lcENjbCk7CiAgICBzdGF0ZS5zb3VyY2VUc01zID0gdG9OdW1iZXIoY2FjaGVkUm9vdD8uc291cmNlU3RhdHVzPy5sYXRlc3RTb3VyY2VUc01zKQogICAgICA/PyB0b051bWJlcihjYWNoZWRSb290Py5jdXJyZW50Py5tZXBUc01zKQogICAgICA/PyB0b051bWJlcihjYWNoZWRSb290Py5jdXJyZW50Py5jY2xUc01zKQogICAgICA/PyBudWxsOwogICAgcmVmcmVzaEZyZXNoQmFkZ2VGcm9tU291cmNlKCk7CiAgfQoKICBhcHBseUZpbHRlcihzdGF0ZS5maWx0ZXJNb2RlKTsKCiAgd2luZG93LnNjaGVkdWxlciA9IG5ldyBNYXJrZXRTY2hlZHVsZXIoZmV0Y2hBbGwsIEZFVENIX0lOVEVSVkFMX01TKTsKICB3aW5kb3cuc2NoZWR1bGVyLnN0YXJ0KCk7CiAgZmV0Y2hBbGwoeyBtYW51YWw6IHRydWUgfSk7CgogIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ3Zpc2liaWxpdHljaGFuZ2UnLCAoKSA9PiB7CiAgICBpZiAoZG9jdW1lbnQuaGlkZGVuKSB3aW5kb3cuc2NoZWR1bGVyLnBhdXNlKCk7CiAgICBlbHNlIHdpbmRvdy5zY2hlZHVsZXIucmVzdW1lKCk7CiAgfSk7Cjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4K`;

function decodeBase64Utf8(b64) {
  const compact = b64.replace(/\s+/g, "");
  const binary = atob(compact);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function renderDashboardHtml() {
  return decodeBase64Utf8(DASHBOARD_HTML_B64);
}
