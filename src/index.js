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
      "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self' https://dolarito.ar; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

const DASHBOARD_HTML_B64 = `PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVzIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAiPgo8dGl0bGU+UmFkYXIgTUVQL0NDTCDCtyBNZXJjYWRvIEFSRzwvdGl0bGU+CjxsaW5rIHJlbD0icHJlY29ubmVjdCIgaHJlZj0iaHR0cHM6Ly9mb250cy5nb29nbGVhcGlzLmNvbSI+CjxsaW5rIGhyZWY9Imh0dHBzOi8vZm9udHMuZ29vZ2xlYXBpcy5jb20vY3NzMj9mYW1pbHk9U3BhY2UrTW9ubzp3Z2h0QDQwMDs3MDAmZmFtaWx5PVN5bmU6d2dodEA0MDA7NjAwOzcwMDs4MDAmZGlzcGxheT1zd2FwIiByZWw9InN0eWxlc2hlZXQiPgo8c3R5bGU+Ci8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBUT0tFTlMK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCjpyb290IHsKICAtLWJnOiAgICAgICAjMDgwYjBlOwogIC0tc3VyZjogICAgICMwZjEzMTg7CiAgLS1zdXJmMjogICAgIzE2MWIyMjsKICAtLXN1cmYzOiAgICAjMWMyMzMwOwogIC0tYm9yZGVyOiAgICMxZTI1MzA7CiAgLS1ib3JkZXJCOiAgIzJhMzQ0NDsKCiAgLS1ncmVlbjogICAgIzAwZTY3NjsKICAtLWdyZWVuLWQ6ICByZ2JhKDAsMjMwLDExOCwuMDkpOwogIC0tZ3JlZW4tZzogIHJnYmEoMCwyMzAsMTE4LC4yMik7CiAgLS1yZWQ6ICAgICAgI2ZmNDc1NzsKICAtLXJlZC1kOiAgICByZ2JhKDI1NSw3MSw4NywuMDkpOwogIC0teWVsbG93OiAgICNmZmMgYzAwOwogIC0teWVsbG93OiAgICNmZmNjMDA7CiAgLS15ZWxsb3ctZDogcmdiYSgyNTUsMjA0LDAsLjA5KTsKCiAgLS1tZXA6ICAgICAgIzI5YjZmNjsKICAtLWNjbDogICAgICAjYjM5ZGRiOwogIC0tdGV4dDogICAgICNkZGU0ZWU7CiAgLS1tdXRlZDogICAgIzU1NjA3MDsKICAtLW11dGVkMjogICAjN2E4ZmE4OwoKICAtLW1vbm86ICdTcGFjZSBNb25vJywgbW9ub3NwYWNlOwogIC0tc2FuczogJ1N5bmUnLCBzYW5zLXNlcmlmOwoKICAtLWRyYXdlci13OiA0MDBweDsKICAtLWhlYWRlci1oOiA1NHB4Owp9CgoqLCAqOjpiZWZvcmUsICo6OmFmdGVyIHsgYm94LXNpemluZzogYm9yZGVyLWJveDsgbWFyZ2luOiAwOyBwYWRkaW5nOiAwOyB9CgpodG1sIHsgc2Nyb2xsLWJlaGF2aW9yOiBzbW9vdGg7IH0KCmJvZHkgewogIGJhY2tncm91bmQ6IHZhcigtLWJnKTsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgZm9udC1mYW1pbHk6IHZhcigtLW1vbm8pOwogIG1pbi1oZWlnaHQ6IDEwMHZoOwogIG92ZXJmbG93LXg6IGhpZGRlbjsKfQoKYm9keTo6YmVmb3JlIHsKICBjb250ZW50OiAnJzsKICBwb3NpdGlvbjogZml4ZWQ7IGluc2V0OiAwOwogIGJhY2tncm91bmQtaW1hZ2U6CiAgICBsaW5lYXItZ3JhZGllbnQocmdiYSg0MSwxODIsMjQ2LC4wMjUpIDFweCwgdHJhbnNwYXJlbnQgMXB4KSwKICAgIGxpbmVhci1ncmFkaWVudCg5MGRlZywgcmdiYSg0MSwxODIsMjQ2LC4wMjUpIDFweCwgdHJhbnNwYXJlbnQgMXB4KTsKICBiYWNrZ3JvdW5kLXNpemU6IDQ0cHggNDRweDsKICBwb2ludGVyLWV2ZW50czogbm9uZTsgei1pbmRleDogMDsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIExBWU9VVCBTSEVMTArilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLmFwcCB7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBtaW4taGVpZ2h0OiAxMDB2aDsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIEhFQURFUgrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KaGVhZGVyIHsKICBwb3NpdGlvbjogc3RpY2t5OyB0b3A6IDA7IHotaW5kZXg6IDIwMDsKICBoZWlnaHQ6IHZhcigtLWhlYWRlci1oKTsKICBiYWNrZ3JvdW5kOiByZ2JhKDgsMTEsMTQsLjkzKTsKICBiYWNrZHJvcC1maWx0ZXI6IGJsdXIoMThweCk7CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgcGFkZGluZzogMCAyMnB4OwogIGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsKfQoKLmxvZ28gewogIGZvbnQtZmFtaWx5OiB2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6IDgwMDsgZm9udC1zaXplOiAxNXB4OwogIGxldHRlci1zcGFjaW5nOiAuMDVlbTsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA5cHg7Cn0KCi5saXZlLWRvdCB7CiAgd2lkdGg6IDdweDsgaGVpZ2h0OiA3cHg7IGJvcmRlci1yYWRpdXM6IDUwJTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1ncmVlbik7CiAgYm94LXNoYWRvdzogMCAwIDhweCB2YXIoLS1ncmVlbik7CiAgYW5pbWF0aW9uOiBibGluayAyLjJzIGVhc2UtaW4tb3V0IGluZmluaXRlOwp9CkBrZXlmcmFtZXMgYmxpbmsgewogIDAlLDEwMCV7b3BhY2l0eToxO2JveC1zaGFkb3c6MCAwIDhweCB2YXIoLS1ncmVlbik7fQogIDUwJXtvcGFjaXR5Oi4zNTtib3gtc2hhZG93OjAgMCAzcHggdmFyKC0tZ3JlZW4pO30KfQoKLmhlYWRlci1yaWdodCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMTJweDsgfQoKLmZyZXNoLWJhZGdlIHsKICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDVweDsKICBmb250LXNpemU6IDExcHg7IGNvbG9yOiB2YXIoLS1tdXRlZDIpOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYyKTsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOiAyMHB4OyBwYWRkaW5nOiAzcHggMTFweDsKfQouZnJlc2gtZG90IHsgd2lkdGg6NXB4O2hlaWdodDo1cHg7Ym9yZGVyLXJhZGl1czo1MCU7YmFja2dyb3VuZDp2YXIoLS1ncmVlbik7YW5pbWF0aW9uOmJsaW5rIDIuMnMgZWFzZS1pbi1vdXQgaW5maW5pdGU7IH0KLmZyZXNoLWJhZGdlLmZldGNoaW5nIHsgYW5pbWF0aW9uOiBiYWRnZVB1bHNlIDEuMnMgZWFzZS1pbi1vdXQgaW5maW5pdGU7IH0KLmZyZXNoLWJhZGdlLmVycm9yIHsgY29sb3I6I2ZmZDBkMDsgYm9yZGVyLWNvbG9yOnJnYmEoMjU1LDgyLDgyLC40NSk7IGJhY2tncm91bmQ6cmdiYSgyNTUsODIsODIsLjEyKTsgY3Vyc29yOnBvaW50ZXI7IH0KQGtleWZyYW1lcyBiYWRnZVB1bHNlIHsKICAwJSwxMDAlIHsgb3BhY2l0eToxOyB9CiAgNTAlIHsgb3BhY2l0eTouNjU7IH0KfQoKLnRhZy1tZXJjYWRvIHsKICBmb250LWZhbWlseTogdmFyKC0tc2Fucyk7IGZvbnQtc2l6ZToxMHB4OyBmb250LXdlaWdodDo3MDA7CiAgbGV0dGVyLXNwYWNpbmc6LjA4ZW07IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsKICBiYWNrZ3JvdW5kOnZhcigtLWdyZWVuKTsgY29sb3I6IzAwMDsKICBwYWRkaW5nOjNweCA5cHg7IGJvcmRlci1yYWRpdXM6NHB4Owp9Ci50YWctbWVyY2Fkby5jbG9zZWQgeyBiYWNrZ3JvdW5kOnZhcigtLW11dGVkKTsgY29sb3I6IzBhMGMwZjsgfQoKLmJ0biB7CiAgZm9udC1mYW1pbHk6IHZhcigtLXNhbnMpOyBmb250LXNpemU6MTFweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4wN2VtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7CiAgYm9yZGVyLXJhZGl1czo2cHg7IHBhZGRpbmc6NnB4IDE0cHg7IGN1cnNvcjpwb2ludGVyOwogIGJvcmRlcjpub25lOyB0cmFuc2l0aW9uOiBhbGwgLjE4czsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo2cHg7Cn0KLmJ0bi1hbGVydCB7IGJhY2tncm91bmQ6dmFyKC0tZ3JlZW4pOyBjb2xvcjojMDAwOyB9Ci5idG4tYWxlcnQ6aG92ZXIgeyBiYWNrZ3JvdW5kOiMwMGZmODg7IHRyYW5zZm9ybTp0cmFuc2xhdGVZKC0xcHgpOyB9CgouYnRuLXRhc2FzIHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMik7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyQik7CiAgY29sb3I6IHZhcigtLXRleHQpOwp9Ci5idG4tdGFzYXM6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMyk7IGJvcmRlci1jb2xvcjogdmFyKC0tbXV0ZWQyKTsgfQouYnRuLXRhc2FzLmFjdGl2ZSB7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZjMpOwogIGJvcmRlci1jb2xvcjogdmFyKC0teWVsbG93KTsKICBjb2xvcjogdmFyKC0teWVsbG93KTsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIE1BSU4gKyBEUkFXRVIgTEFZT1VUCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwouYm9keS13cmFwIHsKICBmbGV4OiAxOwogIGRpc3BsYXk6IGZsZXg7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIHotaW5kZXg6IDE7CiAgdHJhbnNpdGlvbjogbm9uZTsKfQoKLm1haW4tY29udGVudCB7CiAgZmxleDogMTsKICBtYXgtd2lkdGg6IDEwMCU7CiAgcGFkZGluZzogMjJweCAyMnB4IDYwcHg7CiAgdHJhbnNpdGlvbjogbWFyZ2luLXJpZ2h0IC4zNXMgY3ViaWMtYmV6aWVyKC40LDAsLjIsMSk7Cn0KCi5ib2R5LXdyYXAuZHJhd2VyLW9wZW4gLm1haW4tY29udGVudCB7CiAgbWFyZ2luLXJpZ2h0OiB2YXIoLS1kcmF3ZXItdyk7Cn0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBEUkFXRVIK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5kcmF3ZXIgewogIHBvc2l0aW9uOiBmaXhlZDsKICB0b3A6IHZhcigtLWhlYWRlci1oKTsKICByaWdodDogMDsKICB3aWR0aDogdmFyKC0tZHJhd2VyLXcpOwogIGhlaWdodDogY2FsYygxMDB2aCAtIHZhcigtLWhlYWRlci1oKSk7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZik7CiAgYm9yZGVyLWxlZnQ6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIHRyYW5zZm9ybTogdHJhbnNsYXRlWCgxMDAlKTsKICB0cmFuc2l0aW9uOiB0cmFuc2Zvcm0gLjM1cyBjdWJpYy1iZXppZXIoLjQsMCwuMiwxKTsKICBvdmVyZmxvdy15OiBhdXRvOwogIHotaW5kZXg6IDE1MDsKICBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwp9CgouZHJhd2VyLm9wZW4geyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVgoMCk7IH0KCi5kcmF3ZXItaGVhZGVyIHsKICBwb3NpdGlvbjogc3RpY2t5OyB0b3A6IDA7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZik7CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgcGFkZGluZzogMTZweCAyMHB4OwogIGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsKICB6LWluZGV4OiAxMDsKfQoKLmRyYXdlci10aXRsZSB7CiAgZm9udC1mYW1pbHk6IHZhcigtLXNhbnMpOyBmb250LXdlaWdodDogODAwOyBmb250LXNpemU6IDEzcHg7CiAgbGV0dGVyLXNwYWNpbmc6LjA0ZW07IGNvbG9yOiB2YXIoLS10ZXh0KTsKICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo4cHg7Cn0KCi5kcmF3ZXItc291cmNlIHsKICBmb250LXNpemU6MTBweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBmb250LWZhbWlseTp2YXIoLS1tb25vKTsKfQoKLmJ0bi1jbG9zZSB7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmMik7IGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBjb2xvcjp2YXIoLS1tdXRlZDIpOyBib3JkZXItcmFkaXVzOjZweDsgcGFkZGluZzo1cHggMTBweDsKICBjdXJzb3I6cG9pbnRlcjsgZm9udC1zaXplOjEzcHg7IHRyYW5zaXRpb246IGFsbCAuMTVzOwp9Ci5idG4tY2xvc2U6aG92ZXIgeyBjb2xvcjp2YXIoLS10ZXh0KTsgYm9yZGVyLWNvbG9yOnZhcigtLW11dGVkMik7IH0KCi5kcmF3ZXItYm9keSB7IHBhZGRpbmc6IDE2cHggMjBweDsgZGlzcGxheTogZmxleDsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgZ2FwOiAyMnB4OyB9CgovKiDilIDilIAgRFJBV0VSIFNFQ1RJT05TIOKUgOKUgCAqLwouZC1zZWN0aW9uLWxhYmVsIHsKICBmb250LWZhbWlseTogdmFyKC0tc2Fucyk7IGZvbnQtc2l6ZToxMHB4OyBmb250LXdlaWdodDo3MDA7CiAgbGV0dGVyLXNwYWNpbmc6LjEyZW07IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsKICBjb2xvcjp2YXIoLS1tdXRlZCk7IG1hcmdpbi1ib3R0b206MTBweDsKICBkaXNwbGF5OmZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsgZ2FwOjhweDsKfQouZC1zZWN0aW9uLWxhYmVsOjphZnRlciB7CiAgY29udGVudDonJzsgZmxleDoxOyBoZWlnaHQ6MXB4OyBiYWNrZ3JvdW5kOnZhcigtLWJvcmRlcik7Cn0KCi8qIENhdWNpw7NuIGNhcmRzICovCi5jYXVjaW9uLWdyaWQgeyBkaXNwbGF5OmdyaWQ7IGdyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyIDFmcjsgZ2FwOjhweDsgfQoKLmNhdWNpb24tY2FyZCB7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZjIpOwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czo5cHg7IHBhZGRpbmc6MTJweCAxMHB4OwogIHRleHQtYWxpZ246Y2VudGVyOwogIHRyYW5zaXRpb246IGJvcmRlci1jb2xvciAuMTVzOwp9Ci5jYXVjaW9uLWNhcmQ6aG92ZXIgeyBib3JkZXItY29sb3I6dmFyKC0tYm9yZGVyQik7IH0KCi5jYXVjaW9uLXBsYXpvIHsKICBmb250LXNpemU6MTBweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBsZXR0ZXItc3BhY2luZzouMDhlbTsKICB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7IG1hcmdpbi1ib3R0b206NnB4OyBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6NjAwOwp9CgouY2F1Y2lvbi10bmEgewogIGZvbnQtc2l6ZToyMHB4OyBmb250LXdlaWdodDo3MDA7IGNvbG9yOnZhcigtLXllbGxvdyk7CiAgbGluZS1oZWlnaHQ6MTsKfQouY2F1Y2lvbi11bml0IHsgZm9udC1zaXplOjlweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBtYXJnaW4tdG9wOjNweDsgfQoKLmNhdWNpb24tZGVsdGEgewogIGZvbnQtc2l6ZToxMHB4OyBtYXJnaW4tdG9wOjVweDsKfQouZGVsdGEtdXAgeyBjb2xvcjp2YXIoLS1ncmVlbik7IH0KLmRlbHRhLWRvd24geyBjb2xvcjp2YXIoLS1yZWQpOyB9Ci5kZWx0YS1mbGF0IHsgY29sb3I6dmFyKC0tbXV0ZWQpOyB9CgovKiBCb25vcyB0YWJsZSAqLwouYm9ub3MtdGFibGUgeyB3aWR0aDoxMDAlOyBib3JkZXItY29sbGFwc2U6Y29sbGFwc2U7IH0KCi5ib25vcy10YWJsZSB0aGVhZCB0aCB7CiAgZm9udC1zaXplOjlweDsgbGV0dGVyLXNwYWNpbmc6LjFlbTsgdGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOwogIGNvbG9yOnZhcigtLW11dGVkKTsgcGFkZGluZzo2cHggOHB4OyB0ZXh0LWFsaWduOmxlZnQ7CiAgZm9udC1mYW1pbHk6dmFyKC0tc2Fucyk7IGZvbnQtd2VpZ2h0OjYwMDsKICBib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwp9CgouYm9ub3MtdGFibGUgdGJvZHkgdHIgewogIGJvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgdHJhbnNpdGlvbjogYmFja2dyb3VuZCAuMTJzOwp9Ci5ib25vcy10YWJsZSB0Ym9keSB0cjpob3ZlciB7IGJhY2tncm91bmQ6cmdiYSg0MSwxODIsMjQ2LC4wNCk7IH0KLmJvbm9zLXRhYmxlIHRib2R5IHRyOmxhc3QtY2hpbGQgeyBib3JkZXItYm90dG9tOm5vbmU7IH0KCi5ib25vcy10YWJsZSB0Ym9keSB0ZCB7CiAgcGFkZGluZzoxMHB4IDhweDsgZm9udC1zaXplOjEycHg7Cn0KCi5ib25vLXRpY2tlciB7CiAgZm9udC13ZWlnaHQ6NzAwOyBjb2xvcjp2YXIoLS10ZXh0KTsKICBmb250LXNpemU6MTNweDsKfQouYm9uby1ub21icmUgeyBmb250LXNpemU6OXB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7IG1hcmdpbi10b3A6MnB4OyB9CgoudGlyLXZhbCB7IGNvbG9yOnZhcigtLXllbGxvdyk7IGZvbnQtd2VpZ2h0OjcwMDsgfQoucHJlY2lvLXZhbCB7IGNvbG9yOnZhcigtLW11dGVkMik7IH0KCi52YXItcG9zIHsgY29sb3I6dmFyKC0tZ3JlZW4pOyBmb250LXNpemU6MTFweDsgfQoudmFyLW5lZyB7IGNvbG9yOnZhcigtLXJlZCk7IGZvbnQtc2l6ZToxMXB4OyB9CgovKiBMZXRyYXMgKi8KLmxldHJhcy1saXN0IHsgZGlzcGxheTpmbGV4OyBmbGV4LWRpcmVjdGlvbjpjb2x1bW47IGdhcDo4cHg7IH0KCi5sZXRyYS1yb3cgewogIGJhY2tncm91bmQ6dmFyKC0tc3VyZjIpOwogIGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOjhweDsKICBwYWRkaW5nOjExcHggMTRweDsKICBkaXNwbGF5OmZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsganVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47CiAgdHJhbnNpdGlvbjpib3JkZXItY29sb3IgLjE1czsKfQoubGV0cmEtcm93OmhvdmVyIHsgYm9yZGVyLWNvbG9yOnZhcigtLWJvcmRlckIpOyB9CgoubGV0cmEtbGVmdCB7fQoubGV0cmEtdGlja2VyIHsgZm9udC13ZWlnaHQ6NzAwOyBmb250LXNpemU6MTNweDsgY29sb3I6dmFyKC0tdGV4dCk7IH0KLmxldHJhLXZ0byB7IGZvbnQtc2l6ZToxMHB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7IG1hcmdpbi10b3A6MnB4OyB9CgoubGV0cmEtcmF0ZXMgeyBkaXNwbGF5OmZsZXg7IGdhcDoxNHB4OyB0ZXh0LWFsaWduOnJpZ2h0OyB9Ci5sZXRyYS1yYXRlLWJsb2NrIHt9Ci5sZXRyYS1yYXRlLWxhYmVsIHsgZm9udC1zaXplOjlweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBsZXR0ZXItc3BhY2luZzouMDhlbTsgdGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOyBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6NjAwOyB9Ci5sZXRyYS1yYXRlLXZhbCB7IGZvbnQtc2l6ZToxNXB4OyBmb250LXdlaWdodDo3MDA7IGNvbG9yOnZhcigtLWdyZWVuKTsgbWFyZ2luLXRvcDoxcHg7IH0KCi8qIOKUgOKUgCBDb250ZXh0byBjcnV6YWRvIOKUgOKUgCAqLwouY29udGV4dC1ib3ggewogIGJhY2tncm91bmQ6IHJnYmEoMjU1LDIwNCwwLC4wNik7CiAgYm9yZGVyOiAxcHggc29saWQgcmdiYSgyNTUsMjA0LDAsLjIpOwogIGJvcmRlci1yYWRpdXM6IDlweDsKICBwYWRkaW5nOiAxM3B4IDE1cHg7CiAgZm9udC1zaXplOiAxMXB4OwogIGxpbmUtaGVpZ2h0OjEuNjU7CiAgY29sb3I6dmFyKC0tbXV0ZWQyKTsKfQouY29udGV4dC1ib3ggc3Ryb25nIHsgY29sb3I6dmFyKC0teWVsbG93KTsgfQoKLyogRnVlbnRlIHRhZyAqLwouc291cmNlLXRhZyB7CiAgZGlzcGxheTppbmxpbmUtZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBnYXA6NHB4OwogIGZvbnQtc2l6ZTo5cHg7IGNvbG9yOnZhcigtLW11dGVkKTsKICBiYWNrZ3JvdW5kOnZhcigtLXN1cmYzKTsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yYWRpdXM6NHB4OyBwYWRkaW5nOjJweCA3cHg7Cn0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBTVEFUVVMgQkFOTkVSCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwouc3RhdHVzLWJhbm5lciB7CiAgYm9yZGVyLXJhZGl1czoxMXB4OyBwYWRkaW5nOjE4cHggMjRweDsgbWFyZ2luLWJvdHRvbToyMHB4OwogIGJvcmRlcjoxcHggc29saWQ7IGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOwogIGp1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuOwogIGFuaW1hdGlvbjpmYWRlSW4gLjRzIGVhc2U7CiAgb3ZlcmZsb3c6aGlkZGVuOyBwb3NpdGlvbjpyZWxhdGl2ZTsKfQouc3RhdHVzLWJhbm5lci5zaW1pbGFyIHsKICBiYWNrZ3JvdW5kOnZhcigtLWdyZWVuLWQpOyBib3JkZXItY29sb3I6cmdiYSgwLDIzMCwxMTgsLjI4KTsKfQouc3RhdHVzLWJhbm5lci5zaW1pbGFyOjphZnRlciB7CiAgY29udGVudDonJzsgcG9zaXRpb246YWJzb2x1dGU7IHJpZ2h0Oi01MHB4OyB0b3A6NTAlOwogIHRyYW5zZm9ybTp0cmFuc2xhdGVZKC01MCUpOyB3aWR0aDoyMDBweDsgaGVpZ2h0OjIwMHB4OwogIGJvcmRlci1yYWRpdXM6NTAlOwogIGJhY2tncm91bmQ6cmFkaWFsLWdyYWRpZW50KGNpcmNsZSx2YXIoLS1ncmVlbi1nKSAwJSx0cmFuc3BhcmVudCA3MCUpOwogIHBvaW50ZXItZXZlbnRzOm5vbmU7Cn0KLnN0YXR1cy1iYW5uZXIubm8tc2ltaWxhciB7CiAgYmFja2dyb3VuZDogcmdiYSgyNTUsODIsODIsLjA4KTsKICBib3JkZXItY29sb3I6IHJnYmEoMjU1LDgyLDgyLC4zNSk7Cn0KLnN0YXR1cy1iYW5uZXIubm8tc2ltaWxhcjo6YWZ0ZXIgewogIGNvbnRlbnQ6Jyc7CiAgcG9zaXRpb246YWJzb2x1dGU7CiAgcmlnaHQ6LTUwcHg7CiAgdG9wOjUwJTsKICB0cmFuc2Zvcm06dHJhbnNsYXRlWSgtNTAlKTsKICB3aWR0aDoyMDBweDsKICBoZWlnaHQ6MjAwcHg7CiAgYm9yZGVyLXJhZGl1czo1MCU7CiAgYmFja2dyb3VuZDpyYWRpYWwtZ3JhZGllbnQoY2lyY2xlLHJnYmEoMjU1LDgyLDgyLC4xOCkgMCUsdHJhbnNwYXJlbnQgNzAlKTsKICBwb2ludGVyLWV2ZW50czpub25lOwp9Cgoucy1sZWZ0IHt9Ci5zLXRpdGxlIHsKICBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6ODAwOyBmb250LXNpemU6MjZweDsKICBsZXR0ZXItc3BhY2luZzotLjAyZW07IGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBnYXA6MTJweDsKfQoucy1iYWRnZSB7CiAgZm9udC1zaXplOjEwcHg7IGZvbnQtd2VpZ2h0OjcwMDsgbGV0dGVyLXNwYWNpbmc6LjFlbTsKICB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7IHBhZGRpbmc6MnB4IDlweDsgYm9yZGVyLXJhZGl1czo0cHg7CiAgYmFja2dyb3VuZDp2YXIoLS1ncmVlbik7IGNvbG9yOiMwMDA7IGFsaWduLXNlbGY6Y2VudGVyOwp9Ci5zLWJhZGdlLm5vc2ltIHsgYmFja2dyb3VuZDogdmFyKC0tcmVkKTsgY29sb3I6ICNmZmY7IH0KLnMtc3ViIHsgZm9udC1zaXplOjExcHg7IGNvbG9yOnZhcigtLW11dGVkMik7IG1hcmdpbi10b3A6NHB4OyB9CgouZXJyb3ItYmFubmVyIHsKICBkaXNwbGF5Om5vbmU7CiAgbWFyZ2luOiAwIDAgMTRweCAwOwogIHBhZGRpbmc6IDEwcHggMTJweDsKICBib3JkZXItcmFkaXVzOiA4cHg7CiAgYm9yZGVyOiAxcHggc29saWQgcmdiYSgyNTUsODIsODIsLjQ1KTsKICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSw4Miw4MiwuMTIpOwogIGNvbG9yOiAjZmZkMGQwOwogIGZvbnQtc2l6ZTogMTFweDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsKICBnYXA6IDEwcHg7Cn0KLmVycm9yLWJhbm5lci5zaG93IHsgZGlzcGxheTpmbGV4OyB9Ci5lcnJvci1iYW5uZXIgYnV0dG9uIHsKICBib3JkZXI6MXB4IHNvbGlkIHJnYmEoMjU1LDgyLDgyLC41KTsKICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSw4Miw4MiwuMTUpOwogIGNvbG9yOiNmZmRlZGU7CiAgYm9yZGVyLXJhZGl1czo2cHg7CiAgcGFkZGluZzo0cHggMTBweDsKICBmb250LXNpemU6MTBweDsKICBmb250LXdlaWdodDo3MDA7CiAgdGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOwogIGxldHRlci1zcGFjaW5nOi4wNmVtOwogIGN1cnNvcjpwb2ludGVyOwp9Cgouc2tlbGV0b24gewogIGJhY2tncm91bmQ6IGxpbmVhci1ncmFkaWVudCg5MGRlZywgIzFjMjMzMCAyNSUsICMyYTM0NDQgNTAlLCAjMWMyMzMwIDc1JSk7CiAgYmFja2dyb3VuZC1zaXplOiAyMDAlIDEwMCU7CiAgYW5pbWF0aW9uOiBzaGltbWVyIDEuNHMgaW5maW5pdGU7CiAgYm9yZGVyLXJhZGl1czogNHB4OwogIGNvbG9yOiB0cmFuc3BhcmVudDsKICB1c2VyLXNlbGVjdDogbm9uZTsKfQpAa2V5ZnJhbWVzIHNoaW1tZXIgewogIDAlICAgeyBiYWNrZ3JvdW5kLXBvc2l0aW9uOiAyMDAlIDA7IH0KICAxMDAlIHsgYmFja2dyb3VuZC1wb3NpdGlvbjogLTIwMCUgMDsgfQp9CgoudmFsdWUtY2hhbmdlZCB7CiAgYW5pbWF0aW9uOiBmbGFzaFZhbHVlIDYwMG1zIGVhc2U7Cn0KQGtleWZyYW1lcyBmbGFzaFZhbHVlIHsKICAwJSAgIHsgY29sb3I6ICNmZmNjMDA7IH0KICAxMDAlIHsgY29sb3I6IGluaGVyaXQ7IH0KfQoKLnMtcmlnaHQgeyB0ZXh0LWFsaWduOnJpZ2h0OyBmb250LXNpemU6MTFweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBsaW5lLWhlaWdodDoxLjk7IH0KLnMtcmlnaHQgc3Ryb25nIHsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIEhFUk8gQ0FSRFMK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5oZXJvLWdyaWQgewogIGRpc3BsYXk6Z3JpZDsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnIgMWZyOwogIGdhcDoxNHB4OyBtYXJnaW4tYm90dG9tOjIwcHg7Cn0KCi5oY2FyZCB7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmKTsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yYWRpdXM6MTFweDsgcGFkZGluZzoyMHB4IDIycHg7CiAgcG9zaXRpb246cmVsYXRpdmU7IG92ZXJmbG93OmhpZGRlbjsKICB0cmFuc2l0aW9uOmJvcmRlci1jb2xvciAuMThzOwogIGFuaW1hdGlvbjogZmFkZVVwIC41cyBlYXNlIGJvdGg7Cn0KLmhjYXJkOm50aC1jaGlsZCgxKXthbmltYXRpb24tZGVsYXk6LjA4czt9Ci5oY2FyZDpudGgtY2hpbGQoMil7YW5pbWF0aW9uLWRlbGF5Oi4xNnM7fQouaGNhcmQ6bnRoLWNoaWxkKDMpe2FuaW1hdGlvbi1kZWxheTouMjRzO30KLmhjYXJkOmhvdmVyIHsgYm9yZGVyLWNvbG9yOnZhcigtLWJvcmRlckIpOyB9CgouaGNhcmQgLmJhciB7IHBvc2l0aW9uOmFic29sdXRlOyB0b3A6MDtsZWZ0OjA7cmlnaHQ6MDsgaGVpZ2h0OjJweDsgfQouaGNhcmQubWVwIC5iYXIgeyBiYWNrZ3JvdW5kOnZhcigtLW1lcCk7IH0KLmhjYXJkLmNjbCAuYmFyIHsgYmFja2dyb3VuZDp2YXIoLS1jY2wpOyB9Ci5oY2FyZC5nYXAgLmJhciB7IGJhY2tncm91bmQ6dmFyKC0teWVsbG93KTsgfQoKLmhjYXJkLWxhYmVsIHsKICBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC1zaXplOjEwcHg7IGZvbnQtd2VpZ2h0OjcwMDsKICBsZXR0ZXItc3BhY2luZzouMTJlbTsgdGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOyBjb2xvcjp2YXIoLS1tdXRlZCk7CiAgbWFyZ2luLWJvdHRvbTo5cHg7IGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBnYXA6NXB4Owp9Ci5oY2FyZC1sYWJlbCAuZG90IHsgd2lkdGg6NXB4O2hlaWdodDo1cHg7Ym9yZGVyLXJhZGl1czo1MCU7IH0KLm1lcCAuZG90e2JhY2tncm91bmQ6dmFyKC0tbWVwKTt9Ci5jY2wgLmRvdHtiYWNrZ3JvdW5kOnZhcigtLWNjbCk7fQouZ2FwIC5kb3R7YmFja2dyb3VuZDp2YXIoLS15ZWxsb3cpO30KCi5oY2FyZC12YWwgewogIGZvbnQtc2l6ZTozNHB4OyBmb250LXdlaWdodDo3MDA7IGxldHRlci1zcGFjaW5nOi0uMDJlbTsgbGluZS1oZWlnaHQ6MTsKfQoubWVwIC5oY2FyZC12YWx7Y29sb3I6dmFyKC0tbWVwKTt9Ci5jY2wgLmhjYXJkLXZhbHtjb2xvcjp2YXIoLS1jY2wpO30KCi5oY2FyZC1wY3QgeyBmb250LXNpemU6MjBweDsgY29sb3I6dmFyKC0teWVsbG93KTsgZm9udC13ZWlnaHQ6NzAwOyBtYXJnaW4tdG9wOjNweDsgfQouaGNhcmQtc3ViIHsgZm9udC1zaXplOjEwcHg7IGNvbG9yOnZhcigtLW11dGVkKTsgbWFyZ2luLXRvcDo3cHg7IH0KCi8qIHRvb2x0aXAgKi8KLnRpcCB7IHBvc2l0aW9uOnJlbGF0aXZlOyBjdXJzb3I6aGVscDsgfQoudGlwOjphZnRlciB7CiAgY29udGVudDphdHRyKGRhdGEtdCk7CiAgcG9zaXRpb246YWJzb2x1dGU7IGJvdHRvbTpjYWxjKDEwMCUgKyA3cHgpOyBsZWZ0OjUwJTsKICB0cmFuc2Zvcm06dHJhbnNsYXRlWCgtNTAlKTsKICBiYWNrZ3JvdW5kOiMxYTIyMzI7IGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyQik7CiAgY29sb3I6dmFyKC0tdGV4dCk7IGZvbnQtc2l6ZToxMHB4OyBwYWRkaW5nOjVweCA5cHg7CiAgYm9yZGVyLXJhZGl1czo2cHg7IHdoaXRlLXNwYWNlOm5vd3JhcDsKICBvcGFjaXR5OjA7IHBvaW50ZXItZXZlbnRzOm5vbmU7IHRyYW5zaXRpb246b3BhY2l0eSAuMThzOyB6LWluZGV4Ojk5Owp9Ci50aXA6aG92ZXI6OmFmdGVye29wYWNpdHk6MTt9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgQ0hBUlQK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5jaGFydC1jYXJkIHsKICBiYWNrZ3JvdW5kOnZhcigtLXN1cmYpOyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czoxMXB4OyBwYWRkaW5nOjIycHg7IG1hcmdpbi1ib3R0b206MjBweDsKICBhbmltYXRpb246ZmFkZVVwIC41cyAuMzJzIGVhc2UgYm90aDsKfQouY2hhcnQtdG9wIHsKICBkaXNwbGF5OmZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsganVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47CiAgbWFyZ2luLWJvdHRvbToxNnB4Owp9Ci5jaGFydC10dGwgeyBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6NzAwOyBmb250LXNpemU6MTNweDsgfQoKLnBpbGxzIHsgZGlzcGxheTpmbGV4OyBnYXA6NXB4OyB9Ci5waWxsIHsKICBmb250LXNpemU6MTBweDsgcGFkZGluZzozcHggMTFweDsgYm9yZGVyLXJhZGl1czoyMHB4OwogIGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyQik7IGNvbG9yOnZhcigtLW11dGVkMik7CiAgYmFja2dyb3VuZDp0cmFuc3BhcmVudDsgY3Vyc29yOnBvaW50ZXI7IGZvbnQtZmFtaWx5OnZhcigtLW1vbm8pOwogIHRyYW5zaXRpb246YWxsIC4xM3M7Cn0KLnBpbGwub24geyBiYWNrZ3JvdW5kOnZhcigtLW1lcCk7IGJvcmRlci1jb2xvcjp2YXIoLS1tZXApOyBjb2xvcjojMDAwOyBmb250LXdlaWdodDo3MDA7IH0KCi5sZWdlbmRzIHsgZGlzcGxheTpmbGV4OyBnYXA6MThweDsgbWFyZ2luLWJvdHRvbToxNHB4OyBmb250LXNpemU6MTBweDsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgfQoubGVnIHsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo1cHg7IH0KLmxlZy1saW5lIHsgd2lkdGg6MThweDsgaGVpZ2h0OjJweDsgYm9yZGVyLXJhZGl1czoycHg7IH0KCnN2Zy5jaGFydCB7IHdpZHRoOjEwMCU7IGhlaWdodDoxNzBweDsgb3ZlcmZsb3c6dmlzaWJsZTsgfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIE1FVFJJQ1MK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5tZXRyaWNzLWdyaWQgewogIGRpc3BsYXk6Z3JpZDsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCg0LDFmcik7CiAgZ2FwOjEycHg7IG1hcmdpbi1ib3R0b206MjBweDsKfQoubWNhcmQgewogIGJhY2tncm91bmQ6dmFyKC0tc3VyZjIpOyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czo5cHg7IHBhZGRpbmc6MTRweCAxNnB4OwogIGFuaW1hdGlvbjpmYWRlVXAgLjVzIGVhc2UgYm90aDsKfQoubWNhcmQ6bnRoLWNoaWxkKDEpe2FuaW1hdGlvbi1kZWxheTouMzhzO30KLm1jYXJkOm50aC1jaGlsZCgyKXthbmltYXRpb24tZGVsYXk6LjQzczt9Ci5tY2FyZDpudGgtY2hpbGQoMyl7YW5pbWF0aW9uLWRlbGF5Oi40OHM7fQoubWNhcmQ6bnRoLWNoaWxkKDQpe2FuaW1hdGlvbi1kZWxheTouNTNzO30KLm1jYXJkLWxhYmVsIHsKICBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC1zaXplOjlweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4xZW07IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsgY29sb3I6dmFyKC0tbXV0ZWQpOyBtYXJnaW4tYm90dG9tOjdweDsKfQoubWNhcmQtdmFsIHsgZm9udC1zaXplOjIwcHg7IGZvbnQtd2VpZ2h0OjcwMDsgfQoubWNhcmQtc3ViIHsgZm9udC1zaXplOjlweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBtYXJnaW4tdG9wOjNweDsgfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIFRBQkxFCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwoudGFibGUtY2FyZCB7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmKTsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yYWRpdXM6MTFweDsgb3ZlcmZsb3c6aGlkZGVuOwogIGFuaW1hdGlvbjpmYWRlVXAgLjVzIC41NnMgZWFzZSBib3RoOwp9Ci50YWJsZS10b3AgewogIHBhZGRpbmc6MTRweCAyMnB4OyBib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjsKfQoudGFibGUtdHRsIHsgZm9udC1mYW1pbHk6dmFyKC0tc2Fucyk7IGZvbnQtd2VpZ2h0OjcwMDsgZm9udC1zaXplOjEzcHg7IH0KLnRhYmxlLWNhcCB7IGZvbnQtc2l6ZToxMHB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7IH0KCnRhYmxlIHsgd2lkdGg6MTAwJTsgYm9yZGVyLWNvbGxhcHNlOmNvbGxhcHNlOyB9CnRoZWFkIHRoIHsKICBmb250LXNpemU6OXB4OyBsZXR0ZXItc3BhY2luZzouMWVtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7CiAgY29sb3I6dmFyKC0tbXV0ZWQpOyBwYWRkaW5nOjlweCAyMnB4OyB0ZXh0LWFsaWduOmxlZnQ7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmMik7IGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXdlaWdodDo2MDA7Cn0KdGJvZHkgdHIgeyBib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOyB0cmFuc2l0aW9uOmJhY2tncm91bmQgLjEyczsgfQp0Ym9keSB0cjpob3ZlciB7IGJhY2tncm91bmQ6cmdiYSg0MSwxODIsMjQ2LC4wNCk7IH0KdGJvZHkgdHI6bGFzdC1jaGlsZCB7IGJvcmRlci1ib3R0b206bm9uZTsgfQp0Ym9keSB0ZCB7IHBhZGRpbmc6MTFweCAyMnB4OyBmb250LXNpemU6MTJweDsgfQp0ZC5kaW0geyBjb2xvcjp2YXIoLS1tdXRlZDIpOyBmb250LXNpemU6MTFweDsgfQoKLnNiYWRnZSB7CiAgZGlzcGxheTppbmxpbmUtYmxvY2s7IGZvbnQtc2l6ZTo5cHg7IGZvbnQtd2VpZ2h0OjcwMDsKICBsZXR0ZXItc3BhY2luZzouMDhlbTsgcGFkZGluZzoycHggN3B4OyBib3JkZXItcmFkaXVzOjRweDsKICB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7Cn0KLnNiYWRnZS5zaW0geyBiYWNrZ3JvdW5kOnZhcigtLWdyZWVuLWQpOyBjb2xvcjp2YXIoLS1ncmVlbik7IGJvcmRlcjoxcHggc29saWQgcmdiYSgwLDIzMCwxMTgsLjIpOyB9Ci5zYmFkZ2Uubm9zaW0geyBiYWNrZ3JvdW5kOnZhcigtLXJlZC1kKTsgY29sb3I6dmFyKC0tcmVkKTsgYm9yZGVyOjFweCBzb2xpZCByZ2JhKDI1NSw3MSw4NywuMik7IH0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBGT09URVIgLyBHTE9TQVJJTwrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLmdsb3NhcmlvIHsKICBtYXJnaW4tdG9wOjIwcHg7IGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOjExcHg7IG92ZXJmbG93OmhpZGRlbjsKICBhbmltYXRpb246ZmFkZVVwIC41cyAuNnMgZWFzZSBib3RoOwp9Ci5nbG9zLWJ0biB7CiAgd2lkdGg6MTAwJTsgYmFja2dyb3VuZDp2YXIoLS1zdXJmKTsgYm9yZGVyOm5vbmU7CiAgY29sb3I6dmFyKC0tbXV0ZWQyKTsgZm9udC1mYW1pbHk6dmFyKC0tbW9ubyk7IGZvbnQtc2l6ZToxMXB4OwogIHBhZGRpbmc6MTNweCAyMnB4OyB0ZXh0LWFsaWduOmxlZnQ7IGN1cnNvcjpwb2ludGVyOwogIGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjsKICB0cmFuc2l0aW9uOmNvbG9yIC4xNXM7Cn0KLmdsb3MtYnRuOmhvdmVyIHsgY29sb3I6dmFyKC0tdGV4dCk7IH0KCi5nbG9zLWdyaWQgewogIGRpc3BsYXk6bm9uZTsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnI7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmMik7IGJvcmRlci10b3A6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Cn0KLmdsb3MtZ3JpZC5vcGVuIHsgZGlzcGxheTpncmlkOyB9CgouZ2kgewogIHBhZGRpbmc6MTRweCAyMnB4OyBib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yaWdodDoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKfQouZ2k6bnRoLWNoaWxkKGV2ZW4pe2JvcmRlci1yaWdodDpub25lO30KLmdpLXRlcm0gewogIGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXNpemU6MTBweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4wOGVtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7IGNvbG9yOnZhcigtLW11dGVkMik7IG1hcmdpbi1ib3R0b206M3B4Owp9Ci5naS1kZWYgeyBmb250LXNpemU6MTFweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBsaW5lLWhlaWdodDoxLjU7IH0KCmZvb3RlciB7CiAgdGV4dC1hbGlnbjpjZW50ZXI7IHBhZGRpbmc6MjJweDsgZm9udC1zaXplOjEwcHg7IGNvbG9yOnZhcigtLW11dGVkKTsKICBib3JkZXItdG9wOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwp9CmZvb3RlciBhIHsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgdGV4dC1kZWNvcmF0aW9uOm5vbmU7IH0KZm9vdGVyIGE6aG92ZXIgeyBjb2xvcjp2YXIoLS10ZXh0KTsgfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIEFOSU1BVElPTlMK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCkBrZXlmcmFtZXMgZmFkZUluIHsgZnJvbXtvcGFjaXR5OjA7fXRve29wYWNpdHk6MTt9IH0KQGtleWZyYW1lcyBmYWRlVXAgeyBmcm9te29wYWNpdHk6MDt0cmFuc2Zvcm06dHJhbnNsYXRlWSgxMHB4KTt9dG97b3BhY2l0eToxO3RyYW5zZm9ybTp0cmFuc2xhdGVZKDApO30gfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIFJFU1BPTlNJVkUK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCkBtZWRpYShtYXgtd2lkdGg6OTAwcHgpewogIDpyb290eyAtLWRyYXdlci13OiAxMDB2dzsgfQogIC5ib2R5LXdyYXAuZHJhd2VyLW9wZW4gLm1haW4tY29udGVudCB7IG1hcmdpbi1yaWdodDowOyB9CiAgLmRyYXdlciB7IHdpZHRoOjEwMHZ3OyB9Cn0KQG1lZGlhKG1heC13aWR0aDo3MDBweCl7CiAgLmhlcm8tZ3JpZHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnI7IH0KICAuaGNhcmQuZ2FweyBncmlkLWNvbHVtbjpzcGFuIDI7IH0KICAubWV0cmljcy1ncmlkeyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcjsgfQogIC5oY2FyZC12YWx7IGZvbnQtc2l6ZToyNnB4OyB9CiAgdGhlYWQgdGg6bnRoLWNoaWxkKDQpLCB0Ym9keSB0ZDpudGgtY2hpbGQoNCl7IGRpc3BsYXk6bm9uZTsgfQogIC5zLXJpZ2h0IHsgZGlzcGxheTpub25lOyB9Cn0KQG1lZGlhKG1heC13aWR0aDo0ODBweCl7CiAgLmhlcm8tZ3JpZHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcjsgfQogIC5oY2FyZC5nYXB7IGdyaWQtY29sdW1uOnNwYW4gMTsgfQogIGhlYWRlcnsgcGFkZGluZzowIDE0cHg7IH0KICAudGFnLW1lcmNhZG97IGRpc3BsYXk6bm9uZTsgfQogIC5idG4tdGFzYXMgc3Bhbi5sYWJlbC1sb25nIHsgZGlzcGxheTpub25lOyB9Cn0KCi8qIERSQVdFUiBPVkVSTEFZIChtb2JpbGUpICovCi5vdmVybGF5IHsKICBkaXNwbGF5Om5vbmU7CiAgcG9zaXRpb246Zml4ZWQ7IGluc2V0OjA7IHotaW5kZXg6MTQwOwogIGJhY2tncm91bmQ6cmdiYSgwLDAsMCwuNTUpOwogIGJhY2tkcm9wLWZpbHRlcjpibHVyKDJweCk7Cn0KQG1lZGlhKG1heC13aWR0aDo5MDBweCl7CiAgLm92ZXJsYXkuc2hvdyB7IGRpc3BsYXk6YmxvY2s7IH0KfQo8L3N0eWxlPgo8L2hlYWQ+Cjxib2R5Pgo8ZGl2IGNsYXNzPSJhcHAiPgoKPCEtLSDilIDilIAgSEVBREVSIOKUgOKUgCAtLT4KPGhlYWRlcj4KICA8ZGl2IGNsYXNzPSJsb2dvIj4KICAgIDxzcGFuIGNsYXNzPSJsaXZlLWRvdCI+PC9zcGFuPgogICAgUkFEQVIgTUVQL0NDTAogIDwvZGl2PgogIDxkaXYgY2xhc3M9ImhlYWRlci1yaWdodCI+CiAgICA8ZGl2IGNsYXNzPSJmcmVzaC1iYWRnZSIgaWQ9ImZyZXNoLWJhZGdlIj4KICAgICAgPHNwYW4gY2xhc3M9ImZyZXNoLWRvdCI+PC9zcGFuPgogICAgICA8c3BhbiBpZD0iZnJlc2gtYmFkZ2UtdGV4dCI+QWN0dWFsaXphbmRv4oCmPC9zcGFuPgogICAgPC9kaXY+CiAgICA8c3BhbiBjbGFzcz0idGFnLW1lcmNhZG8iIGlkPSJ0YWctbWVyY2FkbyI+TWVyY2FkbyBhYmllcnRvPC9zcGFuPgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi10YXNhcyIgaWQ9ImJ0blRhc2FzIiBvbmNsaWNrPSJ0b2dnbGVEcmF3ZXIoKSI+CiAgICAgIPCfk4ogPHNwYW4gY2xhc3M9ImxhYmVsLWxvbmciPlRhc2FzICZhbXA7IEJvbm9zPC9zcGFuPgogICAgPC9idXR0b24+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLWFsZXJ0Ij7wn5SUIEFsZXJ0YXM8L2J1dHRvbj4KICA8L2Rpdj4KPC9oZWFkZXI+Cgo8IS0tIOKUgOKUgCBPVkVSTEFZIChtb2JpbGUpIOKUgOKUgCAtLT4KPGRpdiBjbGFzcz0ib3ZlcmxheSIgaWQ9Im92ZXJsYXkiIG9uY2xpY2s9InRvZ2dsZURyYXdlcigpIj48L2Rpdj4KCjwhLS0g4pSA4pSAIEJPRFkgV1JBUCDilIDilIAgLS0+CjxkaXYgY2xhc3M9ImJvZHktd3JhcCIgaWQ9ImJvZHlXcmFwIj4KCiAgPCEtLSDilZDilZDilZDilZAgTUFJTiDilZDilZDilZDilZAgLS0+CiAgPGRpdiBjbGFzcz0ibWFpbi1jb250ZW50Ij4KCiAgICA8IS0tIFNUQVRVUyBCQU5ORVIgLS0+CiAgICA8ZGl2IGNsYXNzPSJzdGF0dXMtYmFubmVyIHNpbWlsYXIiIGlkPSJzdGF0dXMtYmFubmVyIj4KICAgICAgPGRpdiBjbGFzcz0icy1sZWZ0Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJzLXRpdGxlIj4KICAgICAgICAgIDxzcGFuIGlkPSJzdGF0dXMtbGFiZWwiPk1FUCDiiYggQ0NMPC9zcGFuPgogICAgICAgICAgPHNwYW4gY2xhc3M9InMtYmFkZ2UiIGlkPSJzdGF0dXMtYmFkZ2UiPlNpbWlsYXI8L3NwYW4+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icy1zdWIiPkxhIGJyZWNoYSBlc3TDoSBkZW50cm8gZGVsIHVtYnJhbCDigJQgbG9zIHByZWNpb3Mgc29uIGNvbXBhcmFibGVzPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzLXJpZ2h0Ij4KICAgICAgICA8ZGl2PsOabHRpbWEgY29ycmlkYTogPHN0cm9uZyBpZD0ibGFzdC1ydW4tdGltZSI+4oCUPC9zdHJvbmc+PC9kaXY+CiAgICAgICAgPGRpdiBpZD0iY291bnRkb3duLXRleHQiPlByw7N4aW1hIGFjdHVhbGl6YWNpw7NuIGVuIDU6MDA8L2Rpdj4KICAgICAgICA8ZGl2PkNyb24gR01ULTMgwrcgTHVu4oCTVmllIDEwOjMw4oCTMTg6MDA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImVycm9yLWJhbm5lciIgaWQ9ImVycm9yLWJhbm5lciI+CiAgICAgIDxzcGFuIGlkPSJlcnJvci1iYW5uZXItdGV4dCI+RXJyb3IgYWwgYWN0dWFsaXphciDCtyBSZWludGVudGFyPC9zcGFuPgogICAgICA8YnV0dG9uIGlkPSJlcnJvci1yZXRyeS1idG4iIHR5cGU9ImJ1dHRvbiI+UmVpbnRlbnRhcjwvYnV0dG9uPgogICAgPC9kaXY+CgogICAgPCEtLSBIRVJPIENBUkRTIC0tPgogICAgPGRpdiBjbGFzcz0iaGVyby1ncmlkIj4KICAgICAgPGRpdiBjbGFzcz0iaGNhcmQgbWVwIj4KICAgICAgICA8ZGl2IGNsYXNzPSJiYXIiPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLWxhYmVsIj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJkb3QiPjwvc3Bhbj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0aXAiIGRhdGEtdD0iRMOzbGFyIEJvbHNhIOKAlCBjb21wcmEvdmVudGEgZGUgYm9ub3MgZW4gJEFSUyB5IFVTRCI+TUVQIHZlbnRhIOKTmDwvc3Bhbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC12YWwiIGlkPSJtZXAtdmFsIj4kMS4yNjQ8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC1zdWIiPmRvbGFyaXRvLmFyIMK3IHZlbnRhPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoY2FyZCBjY2wiPgogICAgICAgIDxkaXYgY2xhc3M9ImJhciI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtbGFiZWwiPgogICAgICAgICAgPHNwYW4gY2xhc3M9ImRvdCI+PC9zcGFuPgogICAgICAgICAgPHNwYW4gY2xhc3M9InRpcCIgZGF0YS10PSJDb250YWRvIGNvbiBMaXF1aWRhY2nDs24g4oCUIHNpbWlsYXIgYWwgTUVQIGNvbiBnaXJvIGFsIGV4dGVyaW9yIj5DQ0wgdmVudGEg4pOYPC9zcGFuPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLXZhbCIgaWQ9ImNjbC12YWwiPiQxLjI3MTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLXN1YiI+ZG9sYXJpdG8uYXIgwrcgdmVudGE8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImhjYXJkIGdhcCI+CiAgICAgICAgPGRpdiBjbGFzcz0iYmFyIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC1sYWJlbCI+CiAgICAgICAgICA8c3BhbiBjbGFzcz0iZG90Ij48L3NwYW4+CiAgICAgICAgICA8c3BhbiBjbGFzcz0idGlwIiBkYXRhLXQ9IkJyZWNoYSByZWxhdGl2YSBjb250cmEgZWwgcHJvbWVkaW8gZW50cmUgTUVQIHkgQ0NMIj5CcmVjaGEg4pOYPC9zcGFuPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLXZhbCIgaWQ9ImJyZWNoYS1hYnMiPiQ3PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtcGN0IiBpZD0iYnJlY2hhLXBjdCI+MC41NSU8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC1zdWIiPmRpZmVyZW5jaWEgYWJzb2x1dGEgwrcgcG9yY2VudHVhbDwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAgIDwhLS0gQ0hBUlQgLS0+CiAgICA8ZGl2IGNsYXNzPSJjaGFydC1jYXJkIj4KICAgICAgPGRpdiBjbGFzcz0iY2hhcnQtdG9wIj4KICAgICAgICA8ZGl2IGNsYXNzPSJjaGFydC10dGwiPlRlbmRlbmNpYSBkZSBicmVjaGEg4oCUIMO6bHRpbWFzIDI0aDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InBpbGxzIj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9InBpbGwiPjIwIHB0czwvYnV0dG9uPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0icGlsbCBvbiI+NDAgcHRzPC9idXR0b24+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJwaWxsIj5Ub2RvPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJsZWdlbmRzIj4KICAgICAgICA8ZGl2IGNsYXNzPSJsZWciPjxkaXYgY2xhc3M9ImxlZy1saW5lIiBzdHlsZT0iYmFja2dyb3VuZDp2YXIoLS1tZXApIj48L2Rpdj5NRVA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJsZWciPjxkaXYgY2xhc3M9ImxlZy1saW5lIiBzdHlsZT0iYmFja2dyb3VuZDp2YXIoLS1jY2wpIj48L2Rpdj5DQ0w8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJsZWciPjxkaXYgY2xhc3M9ImxlZy1saW5lIiBzdHlsZT0iYmFja2dyb3VuZDp2YXIoLS15ZWxsb3cpO29wYWNpdHk6LjciPjwvZGl2PkJyZWNoYSAlPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibGVnIj48ZGl2IGNsYXNzPSJsZWctbGluZSIgc3R5bGU9ImJhY2tncm91bmQ6dmFyKC0tZ3JlZW4pO29wYWNpdHk6LjQiPjwvZGl2PlVtYnJhbCAxJTwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPHN2ZyBjbGFzcz0iY2hhcnQiIGlkPSJ0cmVuZC1jaGFydCIgdmlld0JveD0iMCAwIDg2MCAxNjAiIHByZXNlcnZlQXNwZWN0UmF0aW89Im5vbmUiPgogICAgICAgIDxsaW5lIHgxPSIwIiB5MT0iNDAiIHgyPSI4NjAiIHkyPSI0MCIgc3Ryb2tlPSIjMWUyNTMwIiBzdHJva2Utd2lkdGg9IjEiLz4KICAgICAgICA8bGluZSB4MT0iMCIgeTE9IjgwIiB4Mj0iODYwIiB5Mj0iODAiIHN0cm9rZT0iIzFlMjUzMCIgc3Ryb2tlLXdpZHRoPSIxIi8+CiAgICAgICAgPGxpbmUgeDE9IjAiIHkxPSIxMjAiIHgyPSI4NjAiIHkyPSIxMjAiIHN0cm9rZT0iIzFlMjUzMCIgc3Ryb2tlLXdpZHRoPSIxIi8+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXktdG9wIiB4PSIyIiB5PSIzNyIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI4IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC15LW1pZCIgeD0iMiIgeT0iNzciIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iOCIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteS1sb3ciIHg9IjIiIHk9IjExNyIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI4IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgIDxwb2x5bGluZSBpZD0idHJlbmQtbWVwLWxpbmUiIHBvaW50cz0iIiBmaWxsPSJub25lIiBzdHJva2U9IiMyOWI2ZjYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgogICAgICAgIDxwb2x5bGluZSBpZD0idHJlbmQtY2NsLWxpbmUiIHBvaW50cz0iIiBmaWxsPSJub25lIiBzdHJva2U9IiNiMzlkZGIiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgogICAgICAgIDxwb2x5bGluZSBpZD0idHJlbmQtZ2FwLWxpbmUiIHBvaW50cz0iIiBmaWxsPSJub25lIiBzdHJva2U9IiNmZmNjMDAiIHN0cm9rZS13aWR0aD0iMS41IiBzdHJva2UtZGFzaGFycmF5PSI0LDQiIG9wYWNpdHk9Ii43NSIvPgogICAgICAgIDxsaW5lIGlkPSJ0cmVuZC10aHJlc2hvbGQiIHgxPSIzMCIgeTE9IjYyIiB4Mj0iODQwIiB5Mj0iNjIiIHN0cm9rZT0iIzAwZTY3NiIgc3Ryb2tlLXdpZHRoPSIxIiBzdHJva2UtZGFzaGFycmF5PSIzLDkiIG9wYWNpdHk9Ii4yOCIvPgogICAgICAgIDx0ZXh0IHg9Ijg0MyIgeT0iNjUiIGZpbGw9IiMwMGU2NzYiIGZvbnQtc2l6ZT0iNyIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iIG9wYWNpdHk9Ii42Ij4xJTwvdGV4dD4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteC0xIiB4PSIyOCIgeT0iMTU0IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjciIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXgtMiIgeD0iMjE4IiB5PSIxNTQiIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iNyIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteC0zIiB4PSI0MTgiIHk9IjE1NCIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI3IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC14LTQiIHg9IjYwOCIgeT0iMTU0IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjciIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXgtNSIgeD0iNzk4IiB5PSIxNTQiIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iNyIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgPC9zdmc+CiAgICA8L2Rpdj4KCiAgICA8IS0tIE1FVFJJQ1MgLS0+CiAgICA8ZGl2IGNsYXNzPSJtZXRyaWNzLWdyaWQiPgogICAgICA8ZGl2IGNsYXNzPSJtY2FyZCI+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtbGFiZWwiPk11ZXN0cmFzIDI0aDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXZhbCIgaWQ9Im1ldHJpYy1jb3VudC0yNGgiPuKAlDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXN1YiI+cmVnaXN0cm9zIGRlbCBwZXLDrW9kbzwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ibWNhcmQiPgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLWxhYmVsIj5WZWNlcyBzaW1pbGFyPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtdmFsIiBzdHlsZT0iY29sb3I6dmFyKC0tZ3JlZW4pIiBpZD0ibWV0cmljLXNpbWlsYXItMjRoIj7igJQ8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1zdWIiPm1vbWVudG9zIGVuIHpvbmEg4omkMSU8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Im1jYXJkIj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1sYWJlbCI+QnJlY2hhIG3DrW4uPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtdmFsIiBpZD0ibWV0cmljLW1pbi0yNGgiPuKAlDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXN1YiI+bcOtbmltYSByZWdpc3RyYWRhIGhveTwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ibWNhcmQiPgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLWxhYmVsIj5CcmVjaGEgbcOheC48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC12YWwiIHN0eWxlPSJjb2xvcjp2YXIoLS15ZWxsb3cpIiBpZD0ibWV0cmljLW1heC0yNGgiPuKAlDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXN1YiI+bcOheGltYSByZWdpc3RyYWRhIGhveTwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAgIDwhLS0gVEFCTEUgLS0+CiAgICA8ZGl2IGNsYXNzPSJ0YWJsZS1jYXJkIj4KICAgICAgPGRpdiBjbGFzcz0idGFibGUtdG9wIj4KICAgICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS10dGwiPkhpc3RvcmlhbCBkZSByZWdpc3Ryb3M8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS1jYXAiIGlkPSJoaXN0b3J5LWNhcCI+w5psdGltYXMg4oCUIG11ZXN0cmFzPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8dGFibGU+CiAgICAgICAgPHRoZWFkPgogICAgICAgICAgPHRyPgogICAgICAgICAgICA8dGg+SG9yYTwvdGg+CiAgICAgICAgICAgIDx0aD5NRVA8L3RoPgogICAgICAgICAgICA8dGg+Q0NMPC90aD4KICAgICAgICAgICAgPHRoPkRpZiAkPC90aD4KICAgICAgICAgICAgPHRoPkRpZiAlPC90aD4KICAgICAgICAgICAgPHRoPkVzdGFkbzwvdGg+CiAgICAgICAgICA8L3RyPgogICAgICAgIDwvdGhlYWQ+CiAgICAgICAgPHRib2R5IGlkPSJoaXN0b3J5LXJvd3MiPjwvdGJvZHk+CiAgICAgIDwvdGFibGU+CiAgICA8L2Rpdj4KCiAgICA8IS0tIEdMT1NBUklPIC0tPgogICAgPGRpdiBjbGFzcz0iZ2xvc2FyaW8iPgogICAgICA8YnV0dG9uIGNsYXNzPSJnbG9zLWJ0biIgb25jbGljaz0idG9nZ2xlR2xvcyh0aGlzKSI+CiAgICAgICAgPHNwYW4+8J+TliBHbG9zYXJpbyBkZSB0w6lybWlub3M8L3NwYW4+CiAgICAgICAgPHNwYW4gaWQ9Imdsb3NBcnJvdyI+4pa+PC9zcGFuPgogICAgICA8L2J1dHRvbj4KICAgICAgPGRpdiBjbGFzcz0iZ2xvcy1ncmlkIiBpZD0iZ2xvc0dyaWQiPgogICAgICAgIDxkaXYgY2xhc3M9ImdpIj48ZGl2IGNsYXNzPSJnaS10ZXJtIj5NRVAgdmVudGE8L2Rpdj48ZGl2IGNsYXNzPSJnaS1kZWYiPlByZWNpbyBkZSB2ZW50YSBkZWwgZMOzbGFyIE1FUCAoTWVyY2FkbyBFbGVjdHLDs25pY28gZGUgUGFnb3MpIHbDrWEgY29tcHJhL3ZlbnRhIGRlIGJvbm9zIGVuICRBUlMgeSBVU0QuPC9kaXY+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZ2kiPjxkaXYgY2xhc3M9ImdpLXRlcm0iPkNDTCB2ZW50YTwvZGl2PjxkaXYgY2xhc3M9ImdpLWRlZiI+Q29udGFkbyBjb24gTGlxdWlkYWNpw7NuIOKAlCBzaW1pbGFyIGFsIE1FUCBwZXJvIHBlcm1pdGUgdHJhbnNmZXJpciBmb25kb3MgYWwgZXh0ZXJpb3IuIFN1ZWxlIGNvdGl6YXIgbGV2ZW1lbnRlIHBvciBlbmNpbWEuPC9kaXY+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZ2kiPjxkaXYgY2xhc3M9ImdpLXRlcm0iPkRpZmVyZW5jaWEgJTwvZGl2PjxkaXYgY2xhc3M9ImdpLWRlZiI+QnJlY2hhIHJlbGF0aXZhIGNhbGN1bGFkYSBjb250cmEgZWwgcHJvbWVkaW8gZW50cmUgTUVQIHkgQ0NMLiBVbWJyYWwgU0lNSUxBUjog4omkIDElIG8g4omkICQxMCBBUlMuPC9kaXY+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZ2kiPjxkaXYgY2xhc3M9ImdpLXRlcm0iPkZyZXNjdXJhIGRlbCBkYXRvPC9kaXY+PGRpdiBjbGFzcz0iZ2ktZGVmIj5UaWVtcG8gZGVzZGUgZWwgw7psdGltbyB0aW1lc3RhbXAgZGUgZG9sYXJpdG8uYXIuIEVsIGNyb24gY29ycmUgY2FkYSA1IG1pbiBlbiBkw61hcyBow6FiaWxlcy48L2Rpdj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJnaSI+PGRpdiBjbGFzcz0iZ2ktdGVybSI+RXN0YWRvIFNJTUlMQVI8L2Rpdj48ZGl2IGNsYXNzPSJnaS1kZWYiPkN1YW5kbyBNRVAgeSBDQ0wgZXN0w6FuIGRlbnRybyBkZWwgdW1icmFsIOKAlCBtb21lbnRvIGlkZWFsIHBhcmEgb3BlcmFyIGJ1c2NhbmRvIHBhcmlkYWQgZW50cmUgYW1ib3MgdGlwb3MuPC9kaXY+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZ2kiPjxkaXYgY2xhc3M9ImdpLXRlcm0iPk1lcmNhZG8gQVJHPC9kaXY+PGRpdiBjbGFzcz0iZ2ktZGVmIj5WZW50YW5hIG9wZXJhdGl2YTogbHVuZXMgYSB2aWVybmVzIGRlIDEwOjMwIGEgMTc6NTkgKEdNVC0zLCBCdWVub3MgQWlyZXMpLjwvZGl2PjwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAgIDxmb290ZXI+CiAgICAgIEZ1ZW50ZTogPGEgaHJlZj0iIyI+ZG9sYXJpdG8uYXI8L2E+IMK3IDxhIGhyZWY9IiMiPmJ5bWEuY29tLmFyPC9hPiDCtyBEYXRvcyBjYWRhIDUgbWluIGVuIGTDrWFzIGjDoWJpbGVzIMK3IDxhIGhyZWY9IiMiPlJlcG9ydGFyIHByb2JsZW1hPC9hPgogICAgPC9mb290ZXI+CgogIDwvZGl2PjwhLS0gL21haW4tY29udGVudCAtLT4KCiAgPCEtLSDilZDilZDilZDilZAgRFJBV0VSIOKVkOKVkOKVkOKVkCAtLT4KICA8ZGl2IGNsYXNzPSJkcmF3ZXIiIGlkPSJkcmF3ZXIiPgoKICAgIDxkaXYgY2xhc3M9ImRyYXdlci1oZWFkZXIiPgogICAgICA8ZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImRyYXdlci10aXRsZSI+8J+TiiBUYXNhcyAmYW1wOyBCb25vczwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImRyYXdlci1zb3VyY2UiPkZ1ZW50ZXM6IGRvbGFyaXRvLmFyIMK3IGJ5bWEuY29tLmFyPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4tY2xvc2UiIG9uY2xpY2s9InRvZ2dsZURyYXdlcigpIj7inJU8L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImRyYXdlci1ib2R5Ij4KCiAgICAgIDwhLS0g4pSA4pSAIENBVUNJw5NOIOKUgOKUgCAtLT4KICAgICAgPGRpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJkLXNlY3Rpb24tbGFiZWwiPkNhdWNpw7NuIGJ1cnPDoXRpbCAmbmJzcDs8c3BhbiBjbGFzcz0ic291cmNlLXRhZyI+ZG9sYXJpdG8uYXI8L3NwYW4+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iY2F1Y2lvbi1ncmlkIj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImNhdWNpb24tY2FyZCI+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImNhdWNpb24tcGxhem8iPjEgZMOtYTwvZGl2PgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJjYXVjaW9uLXRuYSIgaWQ9ImNhdWNpb24tMWQtdG5hIj41OC4yJTwvZGl2PgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJjYXVjaW9uLXVuaXQiPlROQTwvZGl2PgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJjYXVjaW9uLWRlbHRhIGRlbHRhLXVwIiBpZD0iY2F1Y2lvbi0xZC1kZWx0YSI+4payICsxLjRwcDwvZGl2PgogICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJjYXVjaW9uLWNhcmQiPgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJjYXVjaW9uLXBsYXpvIj43IGTDrWFzPC9kaXY+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImNhdWNpb24tdG5hIiBpZD0iY2F1Y2lvbi03ZC10bmEiPjYxLjUlPC9kaXY+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImNhdWNpb24tdW5pdCI+VE5BPC9kaXY+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImNhdWNpb24tZGVsdGEgZGVsdGEtZmxhdCIgaWQ9ImNhdWNpb24tN2QtZGVsdGEiPuKAlCBzaW4gY2FtYmlvPC9kaXY+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImNhdWNpb24tY2FyZCI+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImNhdWNpb24tcGxhem8iPjMwIGTDrWFzPC9kaXY+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImNhdWNpb24tdG5hIiBpZD0iY2F1Y2lvbi0zMGQtdG5hIj42NC44JTwvZGl2PgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJjYXVjaW9uLXVuaXQiPlROQTwvZGl2PgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJjYXVjaW9uLWRlbHRhIGRlbHRhLWRvd24iIGlkPSJjYXVjaW9uLTMwZC1kZWx0YSI+4pa8IOKIkjAuOHBwPC9kaXY+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IHN0eWxlPSJtYXJnaW4tdG9wOjhweDsgZm9udC1zaXplOjEwcHg7IGNvbG9yOnZhcigtLW11dGVkKSI+CiAgICAgICAgICBURUEgMzBkIGVzdGltYWRhOiA8c3Ryb25nIGlkPSJjYXVjaW9uLXRlYS0zMGQiIHN0eWxlPSJjb2xvcjp2YXIoLS1tdXRlZDIpIj44OC4zJTwvc3Ryb25nPiAmbmJzcDvCtyZuYnNwOyBQYXNhIHNwcmVhZDogPHN0cm9uZyBzdHlsZT0iY29sb3I6dmFyKC0tbXV0ZWQyKSI+KzYuNnBwIHZzIDFkPC9zdHJvbmc+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPCEtLSDilIDilIAgQk9OT1MgU09CRVJBTk9TIOKUgOKUgCAtLT4KICAgICAgPGRpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJkLXNlY3Rpb24tbGFiZWwiPkJvbm9zIHNvYmVyYW5vcyBjbGF2ZSAmbmJzcDs8c3BhbiBjbGFzcz0ic291cmNlLXRhZyI+YnltYS5jb20uYXI8L3NwYW4+PC9kaXY+CiAgICAgICAgPHRhYmxlIGNsYXNzPSJib25vcy10YWJsZSI+CiAgICAgICAgICA8dGhlYWQ+CiAgICAgICAgICAgIDx0cj4KICAgICAgICAgICAgICA8dGg+Qm9ubzwvdGg+CiAgICAgICAgICAgICAgPHRoPlRJUjwvdGg+CiAgICAgICAgICAgICAgPHRoPlByZWNpbzwvdGg+CiAgICAgICAgICAgICAgPHRoPlZhci4gZMOtYTwvdGg+CiAgICAgICAgICAgIDwvdHI+CiAgICAgICAgICA8L3RoZWFkPgogICAgICAgICAgPHRib2R5PgogICAgICAgICAgICA8dHI+CiAgICAgICAgICAgICAgPHRkPgogICAgICAgICAgICAgICAgPGRpdiBjbGFzcz0iYm9uby10aWNrZXIiPkFMMzA8L2Rpdj4KICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImJvbm8tbm9tYnJlIj5Cb25vIEFyZy4gMjAzMCAkPC9kaXY+CiAgICAgICAgICAgICAgPC90ZD4KICAgICAgICAgICAgICA8dGQ+PHNwYW4gY2xhc3M9InRpci12YWwiIGlkPSJib25vLUFMMzAtdGlyIj4xMS40JTwvc3Bhbj48L3RkPgogICAgICAgICAgICAgIDx0ZD48c3BhbiBjbGFzcz0icHJlY2lvLXZhbCIgaWQ9ImJvbm8tQUwzMC1wcmVjaW8iPjY3LjIwPC9zcGFuPjwvdGQ+CiAgICAgICAgICAgICAgPHRkPjxzcGFuIGNsYXNzPSJ2YXItcG9zIiBpZD0iYm9uby1BTDMwLXZhciI+KzEuOCU8L3NwYW4+PC90ZD4KICAgICAgICAgICAgPC90cj4KICAgICAgICAgICAgPHRyPgogICAgICAgICAgICAgIDx0ZD4KICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImJvbm8tdGlja2VyIj5HRDMwPC9kaXY+CiAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJib25vLW5vbWJyZSI+Qm9ubyBBcmcuIDIwMzAgVVNEPC9kaXY+CiAgICAgICAgICAgICAgPC90ZD4KICAgICAgICAgICAgICA8dGQ+PHNwYW4gY2xhc3M9InRpci12YWwiIGlkPSJib25vLUdEMzAtdGlyIj4xMC45JTwvc3Bhbj48L3RkPgogICAgICAgICAgICAgIDx0ZD48c3BhbiBjbGFzcz0icHJlY2lvLXZhbCIgaWQ9ImJvbm8tR0QzMC1wcmVjaW8iPjY5LjUwPC9zcGFuPjwvdGQ+CiAgICAgICAgICAgICAgPHRkPjxzcGFuIGNsYXNzPSJ2YXItcG9zIiBpZD0iYm9uby1HRDMwLXZhciI+KzAuOSU8L3NwYW4+PC90ZD4KICAgICAgICAgICAgPC90cj4KICAgICAgICAgICAgPHRyPgogICAgICAgICAgICAgIDx0ZD4KICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImJvbm8tdGlja2VyIj5BTDM1PC9kaXY+CiAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJib25vLW5vbWJyZSI+Qm9ubyBBcmcuIDIwMzUgJDwvZGl2PgogICAgICAgICAgICAgIDwvdGQ+CiAgICAgICAgICAgICAgPHRkPjxzcGFuIGNsYXNzPSJ0aXItdmFsIiBpZD0iYm9uby1BTDM1LXRpciI+MTIuMSU8L3NwYW4+PC90ZD4KICAgICAgICAgICAgICA8dGQ+PHNwYW4gY2xhc3M9InByZWNpby12YWwiIGlkPSJib25vLUFMMzUtcHJlY2lvIj41Ni44MDwvc3Bhbj48L3RkPgogICAgICAgICAgICAgIDx0ZD48c3BhbiBjbGFzcz0idmFyLW5lZyIgaWQ9ImJvbm8tQUwzNS12YXIiPuKIkjAuNCU8L3NwYW4+PC90ZD4KICAgICAgICAgICAgPC90cj4KICAgICAgICAgICAgPHRyPgogICAgICAgICAgICAgIDx0ZD4KICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImJvbm8tdGlja2VyIj5HRDM1PC9kaXY+CiAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJib25vLW5vbWJyZSI+Qm9ubyBBcmcuIDIwMzUgVVNEPC9kaXY+CiAgICAgICAgICAgICAgPC90ZD4KICAgICAgICAgICAgICA8dGQ+PHNwYW4gY2xhc3M9InRpci12YWwiIGlkPSJib25vLUdEMzUtdGlyIj4xMS44JTwvc3Bhbj48L3RkPgogICAgICAgICAgICAgIDx0ZD48c3BhbiBjbGFzcz0icHJlY2lvLXZhbCIgaWQ9ImJvbm8tR0QzNS1wcmVjaW8iPjU4LjEwPC9zcGFuPjwvdGQ+CiAgICAgICAgICAgICAgPHRkPjxzcGFuIGNsYXNzPSJ2YXItcG9zIiBpZD0iYm9uby1HRDM1LXZhciI+KzAuMyU8L3NwYW4+PC90ZD4KICAgICAgICAgICAgPC90cj4KICAgICAgICAgICAgPHRyPgogICAgICAgICAgICAgIDx0ZD4KICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImJvbm8tdGlja2VyIj5HRDQxPC9kaXY+CiAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJib25vLW5vbWJyZSI+Qm9ubyBBcmcuIDIwNDEgVVNEPC9kaXY+CiAgICAgICAgICAgICAgPC90ZD4KICAgICAgICAgICAgICA8dGQ+PHNwYW4gY2xhc3M9InRpci12YWwiIGlkPSJib25vLUdENDEtdGlyIj4xMi42JTwvc3Bhbj48L3RkPgogICAgICAgICAgICAgIDx0ZD48c3BhbiBjbGFzcz0icHJlY2lvLXZhbCIgaWQ9ImJvbm8tR0Q0MS1wcmVjaW8iPjUyLjQwPC9zcGFuPjwvdGQ+CiAgICAgICAgICAgICAgPHRkPjxzcGFuIGNsYXNzPSJ2YXItbmVnIiBpZD0iYm9uby1HRDQxLXZhciI+4oiSMC43JTwvc3Bhbj48L3RkPgogICAgICAgICAgICA8L3RyPgogICAgICAgICAgPC90Ym9keT4KICAgICAgICA8L3RhYmxlPgogICAgICA8L2Rpdj4KCiAgICAgIDwhLS0g4pSA4pSAIExFVFJBUyBERUwgVEVTT1JPIOKUgOKUgCAtLT4KICAgICAgPGRpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJkLXNlY3Rpb24tbGFiZWwiPkxldHJhcyBkZWwgVGVzb3JvICZuYnNwOzxzcGFuIGNsYXNzPSJzb3VyY2UtdGFnIj5ieW1hLmNvbS5hcjwvc3Bhbj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYXMtbGlzdCI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS1yb3ciPgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS1sZWZ0Ij4KICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS10aWNrZXIiPkxFREUgRmViLTI1PC9kaXY+CiAgICAgICAgICAgICAgPGRpdiBjbGFzcz0ibGV0cmEtdnRvIiBpZD0ibGV0cmEtTEVERS1GRUIyNS12dG8iPlZ0bzogMjgvMDIvMjAyNSDCtyBEZXNjdWVudG88L2Rpdj4KICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImxldHJhLXJhdGVzIj4KICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS1yYXRlLWJsb2NrIj4KICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImxldHJhLXJhdGUtbGFiZWwiPlROQTwvZGl2PgogICAgICAgICAgICAgICAgPGRpdiBjbGFzcz0ibGV0cmEtcmF0ZS12YWwiIGlkPSJsZXRyYS1MRURFLUZFQjI1LXRuYSI+NTcuOCU8L2Rpdj4KICAgICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS1yYXRlLWJsb2NrIj4KICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImxldHJhLXJhdGUtbGFiZWwiPlRFQTwvZGl2PgogICAgICAgICAgICAgICAgPGRpdiBjbGFzcz0ibGV0cmEtcmF0ZS12YWwiIGlkPSJsZXRyYS1MRURFLUZFQjI1LXRlYSIgc3R5bGU9ImNvbG9yOnZhcigtLW11dGVkMikiPjc2LjMlPC9kaXY+CiAgICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS1yb3ciPgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS1sZWZ0Ij4KICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS10aWNrZXIiPkxFQ0FQIE1hci0yNTwvZGl2PgogICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImxldHJhLXZ0byIgaWQ9ImxldHJhLUxFQ0FQLU1BUjI1LXZ0byI+VnRvOiAzMS8wMy8yMDI1IMK3IENhcGl0YWxpemFibGU8L2Rpdj4KICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImxldHJhLXJhdGVzIj4KICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS1yYXRlLWJsb2NrIj4KICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImxldHJhLXJhdGUtbGFiZWwiPlRFTTwvZGl2PgogICAgICAgICAgICAgICAgPGRpdiBjbGFzcz0ibGV0cmEtcmF0ZS12YWwiIGlkPSJsZXRyYS1MRUNBUC1NQVIyNS10bmEiPjQuNiU8L2Rpdj4KICAgICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS1yYXRlLWJsb2NrIj4KICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImxldHJhLXJhdGUtbGFiZWwiPlRFQTwvZGl2PgogICAgICAgICAgICAgICAgPGRpdiBjbGFzcz0ibGV0cmEtcmF0ZS12YWwiIGlkPSJsZXRyYS1MRUNBUC1NQVIyNS10ZWEiIHN0eWxlPSJjb2xvcjp2YXIoLS1tdXRlZDIpIj43Mi4xJTwvZGl2PgogICAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0ibGV0cmEtcm93Ij4KICAgICAgICAgICAgPGRpdiBjbGFzcz0ibGV0cmEtbGVmdCI+CiAgICAgICAgICAgICAgPGRpdiBjbGFzcz0ibGV0cmEtdGlja2VyIj5MRUNBUCBNYXktMjU8L2Rpdj4KICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS12dG8iIGlkPSJsZXRyYS1MRUNBUC1NQVkyNS12dG8iPlZ0bzogMzAvMDUvMjAyNSDCtyBDYXBpdGFsaXphYmxlPC9kaXY+CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS1yYXRlcyI+CiAgICAgICAgICAgICAgPGRpdiBjbGFzcz0ibGV0cmEtcmF0ZS1ibG9jayI+CiAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS1yYXRlLWxhYmVsIj5URU08L2Rpdj4KICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImxldHJhLXJhdGUtdmFsIiBpZD0ibGV0cmEtTEVDQVAtTUFZMjUtdG5hIj40LjklPC9kaXY+CiAgICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgICAgPGRpdiBjbGFzcz0ibGV0cmEtcmF0ZS1ibG9jayI+CiAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS1yYXRlLWxhYmVsIj5URUE8L2Rpdj4KICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImxldHJhLXJhdGUtdmFsIiBpZD0ibGV0cmEtTEVDQVAtTUFZMjUtdGVhIiBzdHlsZT0iY29sb3I6dmFyKC0tbXV0ZWQyKSI+NzguOCU8L2Rpdj4KICAgICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CgogICAgICA8IS0tIOKUgOKUgCBDT05URVhUTyBDUlVaQURPIOKUgOKUgCAtLT4KICAgICAgPGRpdiBjbGFzcz0iY29udGV4dC1ib3giIGlkPSJjb250ZXh0LWJveCI+CiAgICAgICAg8J+SoSA8c3Ryb25nPkNvbnRleHRvOjwvc3Ryb25nPiBDb24gdW5hIGNhdWNpw7NuIGEgMSBkw61hIGFsIDxzdHJvbmc+NTguMiUgVE5BPC9zdHJvbmc+IHkgZWwgQUwzMCByaW5kaWVuZG8gPHN0cm9uZz4xMS40JSBUSVI8L3N0cm9uZz4gZW4gZMOzbGFyZXMsIGxhIGJyZWNoYSBNRVAvQ0NMIGFjdHVhbCBkZSA8c3Ryb25nPjAuNTUlPC9zdHJvbmc+IHN1Z2llcmUgcGFyaWRhZCBvcGVyYXRpdmEuIE1vbWVudG8gZmF2b3JhYmxlIHBhcmEgYXJiaXRyYXIgZW50cmUgaW5zdHJ1bWVudG9zIHNpIHR1IGhvcml6b250ZSBlcyBjb3J0by4KICAgICAgPC9kaXY+CgogICAgPC9kaXY+PCEtLSAvZHJhd2VyLWJvZHkgLS0+CiAgPC9kaXY+PCEtLSAvZHJhd2VyIC0tPgoKPC9kaXY+PCEtLSAvYm9keS13cmFwIC0tPgo8L2Rpdj48IS0tIC9hcHAgLS0+Cgo8c2NyaXB0PgogIC8vIDEpIENvbnN0YW50ZXMgeSBjb25maWd1cmFjacOzbgogIGNvbnN0IEVORFBPSU5UUyA9IHsKICAgIG1lcENjbDogJy9hcGkvZGF0YScsCiAgICBjYXVjaW9uZXM6ICdodHRwczovL2RvbGFyaXRvLmFyL2FwaS9jYXVjaW9uZXMnLAogICAgYm9ub3M6ICdodHRwczovL2RvbGFyaXRvLmFyL2FwaS9ib25vcycsCiAgICBsZXRyYXM6ICdodHRwczovL2RvbGFyaXRvLmFyL2FwaS9sZXRyYXMnCiAgfTsKICBjb25zdCBBUkdfVFogPSAnQW1lcmljYS9BcmdlbnRpbmEvQnVlbm9zX0FpcmVzJzsKICBjb25zdCBGRVRDSF9JTlRFUlZBTF9NUyA9IDMwMDAwMDsKICBjb25zdCBDQUNIRV9LRVkgPSAncmFkYXJfY2FjaGUnOwogIGNvbnN0IENBQ0hFX1RUTF9NUyA9IDE1ICogNjAgKiAxMDAwOwogIGNvbnN0IFJFVFJZX0RFTEFZUyA9IFsxMDAwMCwgMzAwMDAsIDYwMDAwXTsKICBjb25zdCBTSU1JTEFSX1BDVF9USFJFU0hPTEQgPSAxOwogIGNvbnN0IFNJTUlMQVJfQVJTX1RIUkVTSE9MRCA9IDEwOwogIGNvbnN0IFRSRU5EX1BPSU5UUyA9IDQwOwogIGNvbnN0IEhJU1RPUllfUk9XU19MSU1JVCA9IDg7CiAgY29uc3QgQk9OT19USUNLRVJTID0gWydBTDMwJywgJ0dEMzAnLCAnQUwzNScsICdHRDM1JywgJ0dENDEnXTsKICBjb25zdCBMRVRSQV9ST1dTID0gWwogICAgeyBpZDogJ0xFREUtRkVCMjUnLCBtYXRjaDogWydMRURFJywgJ0ZFQicsICcyNSddLCBtb2RlOiAnVE5BJyB9LAogICAgeyBpZDogJ0xFQ0FQLU1BUjI1JywgbWF0Y2g6IFsnTEVDQVAnLCAnTUFSJywgJzI1J10sIG1vZGU6ICdURU0nIH0sCiAgICB7IGlkOiAnTEVDQVAtTUFZMjUnLCBtYXRjaDogWydMRUNBUCcsICdNQVknLCAnMjUnXSwgbW9kZTogJ1RFTScgfQogIF07CiAgY29uc3QgTlVNRVJJQ19JRFMgPSBbCiAgICAnbWVwLXZhbCcsICdjY2wtdmFsJywgJ2JyZWNoYS1hYnMnLCAnYnJlY2hhLXBjdCcsCiAgICAnY2F1Y2lvbi0xZC10bmEnLCAnY2F1Y2lvbi0xZC1kZWx0YScsICdjYXVjaW9uLTdkLXRuYScsICdjYXVjaW9uLTdkLWRlbHRhJywKICAgICdjYXVjaW9uLTMwZC10bmEnLCAnY2F1Y2lvbi0zMGQtZGVsdGEnLCAnY2F1Y2lvbi10ZWEtMzBkJywKICAgICdib25vLUFMMzAtdGlyJywgJ2Jvbm8tQUwzMC1wcmVjaW8nLCAnYm9uby1BTDMwLXZhcicsCiAgICAnYm9uby1HRDMwLXRpcicsICdib25vLUdEMzAtcHJlY2lvJywgJ2Jvbm8tR0QzMC12YXInLAogICAgJ2Jvbm8tQUwzNS10aXInLCAnYm9uby1BTDM1LXByZWNpbycsICdib25vLUFMMzUtdmFyJywKICAgICdib25vLUdEMzUtdGlyJywgJ2Jvbm8tR0QzNS1wcmVjaW8nLCAnYm9uby1HRDM1LXZhcicsCiAgICAnYm9uby1HRDQxLXRpcicsICdib25vLUdENDEtcHJlY2lvJywgJ2Jvbm8tR0Q0MS12YXInLAogICAgJ2xldHJhLUxFREUtRkVCMjUtdG5hJywgJ2xldHJhLUxFREUtRkVCMjUtdGVhJywgJ2xldHJhLUxFREUtRkVCMjUtdnRvJywKICAgICdsZXRyYS1MRUNBUC1NQVIyNS10bmEnLCAnbGV0cmEtTEVDQVAtTUFSMjUtdGVhJywgJ2xldHJhLUxFQ0FQLU1BUjI1LXZ0bycsCiAgICAnbGV0cmEtTEVDQVAtTUFZMjUtdG5hJywgJ2xldHJhLUxFQ0FQLU1BWTI1LXRlYScsICdsZXRyYS1MRUNBUC1NQVkyNS12dG8nCiAgXTsKICBjb25zdCBzdGF0ZSA9IHsKICAgIHJldHJ5SW5kZXg6IDAsCiAgICByZXRyeVRpbWVyOiBudWxsLAogICAgbGFzdFN1Y2Nlc3NBdDogMCwKICAgIGlzRmV0Y2hpbmc6IGZhbHNlLAogICAgbGF0ZXN0OiB7CiAgICAgIG1lcDogbnVsbCwKICAgICAgY2NsOiBudWxsLAogICAgICBicmVjaGFBYnM6IG51bGwsCiAgICAgIGJyZWNoYVBjdDogbnVsbCwKICAgICAgY2F1Y2lvbjFkOiBudWxsLAogICAgICBhbDMwVGlyOiBudWxsCiAgICB9CiAgfTsKCiAgLy8gMikgSGVscGVycwogIGNvbnN0IGZtdEFyZ1RpbWUgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZXMtQVInLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgaG91cjogJzItZGlnaXQnLAogICAgbWludXRlOiAnMi1kaWdpdCcKICB9KTsKICBjb25zdCBmbXRBcmdUaW1lU2VjID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VzLUFSJywgewogICAgdGltZVpvbmU6IEFSR19UWiwKICAgIGhvdXI6ICcyLWRpZ2l0JywKICAgIG1pbnV0ZTogJzItZGlnaXQnLAogICAgc2Vjb25kOiAnMi1kaWdpdCcKICB9KTsKICBjb25zdCBmbXRBcmdIb3VyID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VzLUFSJywgewogICAgdGltZVpvbmU6IEFSR19UWiwKICAgIGhvdXI6ICcyLWRpZ2l0JywKICAgIG1pbnV0ZTogJzItZGlnaXQnLAogICAgaG91cjEyOiBmYWxzZQogIH0pOwogIGNvbnN0IGZtdEFyZ1BhcnRzID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VuLVVTJywgewogICAgdGltZVpvbmU6IEFSR19UWiwKICAgIHdlZWtkYXk6ICdzaG9ydCcsCiAgICBob3VyOiAnMi1kaWdpdCcsCiAgICBtaW51dGU6ICcyLWRpZ2l0JywKICAgIHNlY29uZDogJzItZGlnaXQnLAogICAgaG91cjEyOiBmYWxzZQogIH0pOwogIGNvbnN0IFdFRUtEQVkgPSB7IE1vbjogMSwgVHVlOiAyLCBXZWQ6IDMsIFRodTogNCwgRnJpOiA1LCBTYXQ6IDYsIFN1bjogNyB9OwoKICBmdW5jdGlvbiB0b051bWJlcih2YWx1ZSkgewogICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHZhbHVlKSkgcmV0dXJuIHZhbHVlOwogICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycpIHsKICAgICAgY29uc3Qgbm9ybWFsaXplZCA9IHZhbHVlLnJlcGxhY2UoL1xzL2csICcnKS5yZXBsYWNlKCcsJywgJy4nKS5yZXBsYWNlKC9bXlxkLi1dL2csICcnKTsKICAgICAgY29uc3QgcGFyc2VkID0gTnVtYmVyKG5vcm1hbGl6ZWQpOwogICAgICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHBhcnNlZCkgPyBwYXJzZWQgOiBudWxsOwogICAgfQogICAgcmV0dXJuIG51bGw7CiAgfQogIGZ1bmN0aW9uIGFzQXJyYXkodmFsdWUpIHsKICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkgcmV0dXJuIHZhbHVlOwogICAgaWYgKHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcpIHJldHVybiBPYmplY3QudmFsdWVzKHZhbHVlKTsKICAgIHJldHVybiBbXTsKICB9CiAgZnVuY3Rpb24gbm9ybWFsaXplVGlja2VyKHZhbHVlKSB7CiAgICByZXR1cm4gU3RyaW5nKHZhbHVlIHx8ICcnKS50b1VwcGVyQ2FzZSgpLnJlcGxhY2UoL1teQS1aMC05XS9nLCAnJyk7CiAgfQogIGZ1bmN0aW9uIGdldFBhdGgob2JqLCBwYXRoKSB7CiAgICByZXR1cm4gcGF0aC5yZWR1Y2UoKGFjYywga2V5KSA9PiAoYWNjICYmIGFjY1trZXldICE9PSB1bmRlZmluZWQgPyBhY2Nba2V5XSA6IHVuZGVmaW5lZCksIG9iaik7CiAgfQogIGZ1bmN0aW9uIHBpY2tOdW1iZXIob2JqLCBwYXRocykgewogICAgZm9yIChjb25zdCBwYXRoIG9mIHBhdGhzKSB7CiAgICAgIGNvbnN0IHYgPSBnZXRQYXRoKG9iaiwgcGF0aCk7CiAgICAgIGNvbnN0IG4gPSB0b051bWJlcih2KTsKICAgICAgaWYgKG4gIT09IG51bGwpIHJldHVybiBuOwogICAgfQogICAgcmV0dXJuIG51bGw7CiAgfQogIGZ1bmN0aW9uIHBpY2tCeUtleUhpbnQob2JqLCBoaW50KSB7CiAgICBpZiAoIW9iaiB8fCB0eXBlb2Ygb2JqICE9PSAnb2JqZWN0JykgcmV0dXJuIG51bGw7CiAgICBjb25zdCBsb3dlciA9IGhpbnQudG9Mb3dlckNhc2UoKTsKICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKG9iaikpIHsKICAgICAgaWYgKGsudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhsb3dlcikpIHsKICAgICAgICBjb25zdCBuID0gdG9OdW1iZXIodik7CiAgICAgICAgaWYgKG4gIT09IG51bGwpIHJldHVybiBuOwogICAgICAgIGlmICh2ICYmIHR5cGVvZiB2ID09PSAnb2JqZWN0JykgewogICAgICAgICAgY29uc3QgZGVlcCA9IHBpY2tCeUtleUhpbnQodiwgaGludCk7CiAgICAgICAgICBpZiAoZGVlcCAhPT0gbnVsbCkgcmV0dXJuIGRlZXA7CiAgICAgICAgfQogICAgICB9CiAgICAgIGlmICh2ICYmIHR5cGVvZiB2ID09PSAnb2JqZWN0JykgewogICAgICAgIGNvbnN0IGRlZXAgPSBwaWNrQnlLZXlIaW50KHYsIGhpbnQpOwogICAgICAgIGlmIChkZWVwICE9PSBudWxsKSByZXR1cm4gZGVlcDsKICAgICAgfQogICAgfQogICAgcmV0dXJuIG51bGw7CiAgfQogIGZ1bmN0aW9uIGdldEFyZ05vd1BhcnRzKGRhdGUgPSBuZXcgRGF0ZSgpKSB7CiAgICBjb25zdCBwYXJ0cyA9IGZtdEFyZ1BhcnRzLmZvcm1hdFRvUGFydHMoZGF0ZSkucmVkdWNlKChhY2MsIHApID0+IHsKICAgICAgYWNjW3AudHlwZV0gPSBwLnZhbHVlOwogICAgICByZXR1cm4gYWNjOwogICAgfSwge30pOwogICAgcmV0dXJuIHsKICAgICAgd2Vla2RheTogV0VFS0RBWVtwYXJ0cy53ZWVrZGF5XSB8fCAwLAogICAgICBob3VyOiBOdW1iZXIocGFydHMuaG91ciB8fCAnMCcpLAogICAgICBtaW51dGU6IE51bWJlcihwYXJ0cy5taW51dGUgfHwgJzAnKSwKICAgICAgc2Vjb25kOiBOdW1iZXIocGFydHMuc2Vjb25kIHx8ICcwJykKICAgIH07CiAgfQogIGZ1bmN0aW9uIHRuYVRvVGVhUGVyY2VudCh0bmFQZXJjZW50KSB7CiAgICBpZiAodG5hUGVyY2VudCA9PT0gbnVsbCkgcmV0dXJuIG51bGw7CiAgICByZXR1cm4gKE1hdGgucG93KDEgKyAodG5hUGVyY2VudCAvIDEwMCkgLyAzNjUsIDM2NSkgLSAxKSAqIDEwMDsKICB9CiAgZnVuY3Rpb24gdGVtVG9UZWFQZXJjZW50KHRlbVBlcmNlbnQpIHsKICAgIGlmICh0ZW1QZXJjZW50ID09PSBudWxsKSByZXR1cm4gbnVsbDsKICAgIHJldHVybiAoTWF0aC5wb3coMSArICh0ZW1QZXJjZW50IC8gMTAwKSwgMTIpIC0gMSkgKiAxMDA7CiAgfQogIGZ1bmN0aW9uIGJyZWNoYVBlcmNlbnQobWVwLCBjY2wpIHsKICAgIGlmIChtZXAgPT09IG51bGwgfHwgY2NsID09PSBudWxsKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGF2ZyA9IChtZXAgKyBjY2wpIC8gMjsKICAgIGlmICghYXZnKSByZXR1cm4gbnVsbDsKICAgIHJldHVybiAoTWF0aC5hYnMobWVwIC0gY2NsKSAvIGF2ZykgKiAxMDA7CiAgfQogIGZ1bmN0aW9uIGZvcm1hdE1vbmV5KHZhbHVlLCBkaWdpdHMgPSAwKSB7CiAgICBpZiAodmFsdWUgPT09IG51bGwpIHJldHVybiAn4oCUJzsKICAgIHJldHVybiAnJCcgKyB2YWx1ZS50b0xvY2FsZVN0cmluZygnZXMtQVInLCB7CiAgICAgIG1pbmltdW1GcmFjdGlvbkRpZ2l0czogZGlnaXRzLAogICAgICBtYXhpbXVtRnJhY3Rpb25EaWdpdHM6IGRpZ2l0cwogICAgfSk7CiAgfQogIGZ1bmN0aW9uIGZvcm1hdFBlcmNlbnQodmFsdWUsIGRpZ2l0cyA9IDIpIHsKICAgIGlmICh2YWx1ZSA9PT0gbnVsbCkgcmV0dXJuICfigJQnOwogICAgcmV0dXJuIHZhbHVlLnRvRml4ZWQoZGlnaXRzKSArICclJzsKICB9CiAgZnVuY3Rpb24gZm9ybWF0RGVsdGFQUCh2YWx1ZSkgewogICAgaWYgKHZhbHVlID09PSBudWxsKSByZXR1cm4gJ+KAlCc7CiAgICBpZiAodmFsdWUgPiAwKSByZXR1cm4gJ+KWsiArJyArIHZhbHVlLnRvRml4ZWQoMSkgKyAncHAnOwogICAgaWYgKHZhbHVlIDwgMCkgcmV0dXJuICfilrwgJyArIHZhbHVlLnRvRml4ZWQoMSkgKyAncHAnOwogICAgcmV0dXJuICfigJQgc2luIGNhbWJpbyc7CiAgfQogIGZ1bmN0aW9uIHNldFRleHQoaWQsIHRleHQsIG9wdGlvbnMgPSB7fSkgewogICAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7CiAgICBpZiAoIWVsKSByZXR1cm47CiAgICBjb25zdCBuZXh0ID0gU3RyaW5nKHRleHQpOwogICAgY29uc3QgcHJldiA9IGVsLnRleHRDb250ZW50OwogICAgZWwudGV4dENvbnRlbnQgPSBuZXh0OwogICAgZWwuY2xhc3NMaXN0LnJlbW92ZSgnc2tlbGV0b24nKTsKICAgIGlmIChvcHRpb25zLmNoYW5nZUNsYXNzICYmIHByZXYgIT09IG5leHQpIHsKICAgICAgZWwuY2xhc3NMaXN0LmFkZCgndmFsdWUtY2hhbmdlZCcpOwogICAgICBzZXRUaW1lb3V0KCgpID0+IGVsLmNsYXNzTGlzdC5yZW1vdmUoJ3ZhbHVlLWNoYW5nZWQnKSwgNjAwKTsKICAgIH0KICB9CiAgZnVuY3Rpb24gc2V0RGFzaChpZHMpIHsKICAgIGlkcy5mb3JFYWNoKChpZCkgPT4gc2V0VGV4dChpZCwgJ+KAlCcpKTsKICB9CiAgZnVuY3Rpb24gc2V0TG9hZGluZyhpZHMsIGlzTG9hZGluZykgewogICAgaWRzLmZvckVhY2goKGlkKSA9PiB7CiAgICAgIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpOwogICAgICBpZiAoIWVsKSByZXR1cm47CiAgICAgIGVsLmNsYXNzTGlzdC50b2dnbGUoJ3NrZWxldG9uJywgaXNMb2FkaW5nKTsKICAgIH0pOwogIH0KICBmdW5jdGlvbiBzZXRWYXJDbGFzcyhlbCwgdmFsdWUpIHsKICAgIGlmICghZWwpIHJldHVybjsKICAgIGVsLmNsYXNzTGlzdC5yZW1vdmUoJ3Zhci1wb3MnLCAndmFyLW5lZycsICdkZWx0YS1mbGF0JywgJ2RlbHRhLXVwJywgJ2RlbHRhLWRvd24nKTsKICAgIGlmICh2YWx1ZSA9PT0gbnVsbCB8fCBNYXRoLmFicyh2YWx1ZSkgPCAwLjAwMDAxKSB7CiAgICAgIGVsLmNsYXNzTGlzdC5hZGQoJ2RlbHRhLWZsYXQnKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgZWwuY2xhc3NMaXN0LmFkZCh2YWx1ZSA+IDAgPyAndmFyLXBvcycgOiAndmFyLW5lZycpOwogIH0KICBmdW5jdGlvbiBzZXRDYXVjaW9uRGVsdGFDbGFzcyhlbCwgdmFsdWUpIHsKICAgIGlmICghZWwpIHJldHVybjsKICAgIGVsLmNsYXNzTGlzdC5yZW1vdmUoJ2RlbHRhLXVwJywgJ2RlbHRhLWRvd24nLCAnZGVsdGEtZmxhdCcpOwogICAgaWYgKHZhbHVlID09PSBudWxsIHx8IE1hdGguYWJzKHZhbHVlKSA8IDAuMDAwMDEpIHsKICAgICAgZWwuY2xhc3NMaXN0LmFkZCgnZGVsdGEtZmxhdCcpOwogICAgICByZXR1cm47CiAgICB9CiAgICBlbC5jbGFzc0xpc3QuYWRkKHZhbHVlID4gMCA/ICdkZWx0YS11cCcgOiAnZGVsdGEtZG93bicpOwogIH0KICBmdW5jdGlvbiBzZXRGcmVzaEJhZGdlKHRleHQsIG1vZGUpIHsKICAgIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZyZXNoLWJhZGdlJyk7CiAgICBjb25zdCBsYWJlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmcmVzaC1iYWRnZS10ZXh0Jyk7CiAgICBpZiAoIWJhZGdlIHx8ICFsYWJlbCkgcmV0dXJuOwogICAgbGFiZWwudGV4dENvbnRlbnQgPSB0ZXh0OwogICAgYmFkZ2UuY2xhc3NMaXN0LnRvZ2dsZSgnZmV0Y2hpbmcnLCBtb2RlID09PSAnZmV0Y2hpbmcnKTsKICAgIGJhZGdlLmNsYXNzTGlzdC50b2dnbGUoJ2Vycm9yJywgbW9kZSA9PT0gJ2Vycm9yJyk7CiAgICBiYWRnZS5vbmNsaWNrID0gbW9kZSA9PT0gJ2Vycm9yJyA/ICgpID0+IGZldGNoQWxsKHsgbWFudWFsOiB0cnVlIH0pIDogbnVsbDsKICB9CiAgZnVuY3Rpb24gc2V0TWFya2V0VGFnKGlzT3BlbikgewogICAgY29uc3QgdGFnID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RhZy1tZXJjYWRvJyk7CiAgICBpZiAoIXRhZykgcmV0dXJuOwogICAgdGFnLnRleHRDb250ZW50ID0gaXNPcGVuID8gJ01lcmNhZG8gYWJpZXJ0bycgOiAnTWVyY2FkbyBjZXJyYWRvJzsKICAgIHRhZy5jbGFzc0xpc3QudG9nZ2xlKCdjbG9zZWQnLCAhaXNPcGVuKTsKICB9CiAgZnVuY3Rpb24gc2V0RXJyb3JCYW5uZXIoc2hvdywgdGV4dCkgewogICAgY29uc3QgYmFubmVyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Vycm9yLWJhbm5lcicpOwogICAgY29uc3QgbGFiZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZXJyb3ItYmFubmVyLXRleHQnKTsKICAgIGlmICghYmFubmVyKSByZXR1cm47CiAgICBpZiAodGV4dCAmJiBsYWJlbCkgbGFiZWwudGV4dENvbnRlbnQgPSB0ZXh0OwogICAgYmFubmVyLmNsYXNzTGlzdC50b2dnbGUoJ3Nob3cnLCAhIXNob3cpOwogIH0KICBmdW5jdGlvbiBleHRyYWN0Um9vdChqc29uKSB7CiAgICByZXR1cm4ganNvbiAmJiB0eXBlb2YganNvbiA9PT0gJ29iamVjdCcgPyAoanNvbi5kYXRhIHx8IGpzb24ucmVzdWx0IHx8IGpzb24pIDoge307CiAgfQoKICAvLyAzKSBGdW5jaW9uZXMgZGUgcmVuZGVyCiAgZnVuY3Rpb24gcmVuZGVyTWVwQ2NsKHBheWxvYWQpIHsKICAgIGlmICghcGF5bG9hZCkgewogICAgICBzZXREYXNoKFsnbWVwLXZhbCcsICdjY2wtdmFsJywgJ2JyZWNoYS1hYnMnLCAnYnJlY2hhLXBjdCddKTsKICAgICAgc2V0VGV4dCgnc3RhdHVzLWxhYmVsJywgJ0RhdG9zIGluY29tcGxldG9zJyk7CiAgICAgIHNldFRleHQoJ3N0YXR1cy1iYWRnZScsICdTaW4gZGF0bycpOwogICAgICByZXR1cm47CiAgICB9CiAgICBjb25zdCBkYXRhID0gZXh0cmFjdFJvb3QocGF5bG9hZCk7CiAgICBjb25zdCBjdXJyZW50ID0gZGF0YSAmJiB0eXBlb2YgZGF0YS5jdXJyZW50ID09PSAnb2JqZWN0JyA/IGRhdGEuY3VycmVudCA6IG51bGw7CiAgICBjb25zdCBtZXAgPSBjdXJyZW50ID8gdG9OdW1iZXIoY3VycmVudC5tZXApIDogKHBpY2tOdW1iZXIoZGF0YSwgW1snbWVwJywgJ3ZlbnRhJ10sIFsnbWVwJywgJ3NlbGwnXSwgWydtZXAnXSwgWydtZXBfdmVudGEnXSwgWydkb2xhcl9tZXAnXV0pID8/IHBpY2tCeUtleUhpbnQoZGF0YSwgJ21lcCcpKTsKICAgIGNvbnN0IGNjbCA9IGN1cnJlbnQgPyB0b051bWJlcihjdXJyZW50LmNjbCkgOiAocGlja051bWJlcihkYXRhLCBbWydjY2wnLCAndmVudGEnXSwgWydjY2wnLCAnc2VsbCddLCBbJ2NjbCddLCBbJ2NjbF92ZW50YSddLCBbJ2RvbGFyX2NjbCddXSkgPz8gcGlja0J5S2V5SGludChkYXRhLCAnY2NsJykpOwogICAgY29uc3QgYWJzID0gY3VycmVudCA/IHRvTnVtYmVyKGN1cnJlbnQuYWJzRGlmZikgPz8gKG1lcCAhPT0gbnVsbCAmJiBjY2wgIT09IG51bGwgPyBNYXRoLmFicyhtZXAgLSBjY2wpIDogbnVsbCkgOiAobWVwICE9PSBudWxsICYmIGNjbCAhPT0gbnVsbCA/IE1hdGguYWJzKG1lcCAtIGNjbCkgOiBudWxsKTsKICAgIGNvbnN0IHBjdCA9IGN1cnJlbnQgPyB0b051bWJlcihjdXJyZW50LnBjdERpZmYpID8/IGJyZWNoYVBlcmNlbnQobWVwLCBjY2wpIDogYnJlY2hhUGVyY2VudChtZXAsIGNjbCk7CiAgICBjb25zdCBpc1NpbWlsYXIgPSBjdXJyZW50ICYmIHR5cGVvZiBjdXJyZW50LnNpbWlsYXIgPT09ICdib29sZWFuJwogICAgICA/IGN1cnJlbnQuc2ltaWxhcgogICAgICA6IChwY3QgIT09IG51bGwgJiYgYWJzICE9PSBudWxsICYmIChwY3QgPD0gU0lNSUxBUl9QQ1RfVEhSRVNIT0xEIHx8IGFicyA8PSBTSU1JTEFSX0FSU19USFJFU0hPTEQpKTsKCiAgICBzZXRUZXh0KCdtZXAtdmFsJywgZm9ybWF0TW9uZXkobWVwLCAyKSwgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ2NjbC12YWwnLCBmb3JtYXRNb25leShjY2wsIDIpLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc2V0VGV4dCgnYnJlY2hhLWFicycsIGFicyA9PT0gbnVsbCA/ICfigJQnIDogZm9ybWF0TW9uZXkoYWJzLCAyKSwgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ2JyZWNoYS1wY3QnLCBmb3JtYXRQZXJjZW50KHBjdCwgMiksIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdzdGF0dXMtbGFiZWwnLCBpc1NpbWlsYXIgPyAnTUVQIOKJiCBDQ0wnIDogJ01FUCDiiaAgQ0NMJyk7CiAgICBzZXRUZXh0KCdzdGF0dXMtYmFkZ2UnLCBpc1NpbWlsYXIgPyAnU2ltaWxhcicgOiAnTm8gc2ltaWxhcicpOwogICAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3RhdHVzLWJhZGdlJyk7CiAgICBpZiAoYmFkZ2UpIGJhZGdlLmNsYXNzTGlzdC50b2dnbGUoJ25vc2ltJywgIWlzU2ltaWxhcik7CgogICAgY29uc3QgYmFubmVyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3N0YXR1cy1iYW5uZXInKTsKICAgIGlmIChiYW5uZXIpIHsKICAgICAgYmFubmVyLmNsYXNzTGlzdC50b2dnbGUoJ3NpbWlsYXInLCAhIWlzU2ltaWxhcik7CiAgICAgIGJhbm5lci5jbGFzc0xpc3QudG9nZ2xlKCduby1zaW1pbGFyJywgIWlzU2ltaWxhcik7CiAgICB9CiAgICBjb25zdCBzdWIgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcjc3RhdHVzLWJhbm5lciAucy1zdWInKTsKICAgIGlmIChzdWIpIHsKICAgICAgc3ViLnRleHRDb250ZW50ID0gaXNTaW1pbGFyCiAgICAgICAgPyAnTGEgYnJlY2hhIGVzdMOhIGRlbnRybyBkZWwgdW1icmFsIOKAlCBsb3MgcHJlY2lvcyBzb24gY29tcGFyYWJsZXMnCiAgICAgICAgOiAnTGEgYnJlY2hhIHN1cGVyYSBlbCB1bWJyYWwg4oCUIGxvcyBwcmVjaW9zIG5vIHNvbiBjb21wYXJhYmxlcyc7CiAgICB9CiAgICBjb25zdCBpc09wZW4gPSBkYXRhPy5tYXJrZXQgJiYgdHlwZW9mIGRhdGEubWFya2V0LmlzT3BlbiA9PT0gJ2Jvb2xlYW4nID8gZGF0YS5tYXJrZXQuaXNPcGVuIDogbnVsbDsKICAgIGlmIChpc09wZW4gIT09IG51bGwpIHNldE1hcmtldFRhZyhpc09wZW4pOwogICAgc3RhdGUubGF0ZXN0Lm1lcCA9IG1lcDsKICAgIHN0YXRlLmxhdGVzdC5jY2wgPSBjY2w7CiAgICBzdGF0ZS5sYXRlc3QuYnJlY2hhQWJzID0gYWJzOwogICAgc3RhdGUubGF0ZXN0LmJyZWNoYVBjdCA9IHBjdDsKICB9CgogIGZ1bmN0aW9uIHJlbmRlckNhdWNpb25lcyhwYXlsb2FkKSB7CiAgICBjb25zdCBpZHMgPSBbCiAgICAgICdjYXVjaW9uLTFkLXRuYScsICdjYXVjaW9uLTFkLWRlbHRhJywgJ2NhdWNpb24tN2QtdG5hJywKICAgICAgJ2NhdWNpb24tN2QtZGVsdGEnLCAnY2F1Y2lvbi0zMGQtdG5hJywgJ2NhdWNpb24tMzBkLWRlbHRhJywgJ2NhdWNpb24tdGVhLTMwZCcKICAgIF07CiAgICBpZiAoIXBheWxvYWQpIHsKICAgICAgc2V0RGFzaChpZHMpOwogICAgICBzdGF0ZS5sYXRlc3QuY2F1Y2lvbjFkID0gbnVsbDsKICAgICAgcmV0dXJuOwogICAgfQogICAgY29uc3QgZGF0YSA9IGV4dHJhY3RSb290KHBheWxvYWQpOwogICAgY29uc3Qgcm93cyA9IGFzQXJyYXkoZGF0YS5jYXVjaW9uZXMgfHwgZGF0YS50YXNhcyB8fCBkYXRhKTsKICAgIGNvbnN0IGJ5RGF5cyA9IHsgMTogbnVsbCwgNzogbnVsbCwgMzA6IG51bGwgfTsKCiAgICByb3dzLmZvckVhY2goKHJhdykgPT4gewogICAgICBpZiAoIXJhdyB8fCB0eXBlb2YgcmF3ICE9PSAnb2JqZWN0JykgcmV0dXJuOwogICAgICBjb25zdCBwbGF6byA9IHRvTnVtYmVyKHJhdy5wbGF6byA/PyByYXcuZGlhcyA/PyByYXcuZGF5cyA/PyByYXcudGVybSk7CiAgICAgIGNvbnN0IHRuYSA9IHRvTnVtYmVyKHJhdy50bmEgPz8gcmF3LnRhc2Ffbm9taW5hbCA/PyByYXcudGFzYSA/PyByYXcucmF0ZSA/PyByYXcudmFsb3IpOwogICAgICBjb25zdCBkZWx0YSA9IHRvTnVtYmVyKHJhdy5kZWx0YSA/PyByYXcudmFyaWFjaW9uID8/IHJhdy52YXIgPz8gcmF3LmNoYW5nZSk7CiAgICAgIGlmIChwbGF6byA9PT0gMSB8fCBwbGF6byA9PT0gNyB8fCBwbGF6byA9PT0gMzApIGJ5RGF5c1twbGF6b10gPSB7IHRuYSwgZGVsdGEgfTsKICAgIH0pOwogICAgaWYgKCFieURheXNbMV0gfHwgIWJ5RGF5c1s3XSB8fCAhYnlEYXlzWzMwXSkgewogICAgICBPYmplY3QuZW50cmllcyhkYXRhKS5mb3JFYWNoKChbaywgdl0pID0+IHsKICAgICAgICBjb25zdCBrZXkgPSBTdHJpbmcoaykudG9Mb3dlckNhc2UoKTsKICAgICAgICBjb25zdCBtYXRjaGVkID0ga2V5LmluY2x1ZGVzKCcxJykgPyAxIDogKGtleS5pbmNsdWRlcygnNycpID8gNyA6IChrZXkuaW5jbHVkZXMoJzMwJykgPyAzMCA6IG51bGwpKTsKICAgICAgICBpZiAoIW1hdGNoZWQgfHwgYnlEYXlzW21hdGNoZWRdKSByZXR1cm47CiAgICAgICAgYnlEYXlzW21hdGNoZWRdID0gewogICAgICAgICAgdG5hOiB0b051bWJlcih2Py50bmEgPz8gdj8udGFzYV9ub21pbmFsID8/IHY/LnJhdGUgPz8gdiksCiAgICAgICAgICBkZWx0YTogdG9OdW1iZXIodj8uZGVsdGEgPz8gdj8udmFyaWFjaW9uID8/IHY/LnZhcikKICAgICAgICB9OwogICAgICB9KTsKICAgIH0KCiAgICBbMSwgNywgMzBdLmZvckVhY2goKGQpID0+IHsKICAgICAgY29uc3Qgcm93ID0gYnlEYXlzW2RdOwogICAgICBzZXRUZXh0KGBjYXVjaW9uLSR7ZH1kLXRuYWAsIHJvdyAmJiByb3cudG5hICE9PSBudWxsID8gZm9ybWF0UGVyY2VudChyb3cudG5hLCAxKSA6ICfigJQnLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgICBzZXRUZXh0KGBjYXVjaW9uLSR7ZH1kLWRlbHRhYCwgcm93ID8gZm9ybWF0RGVsdGFQUChyb3cuZGVsdGEpIDogJ+KAlCcsIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICAgIGNvbnN0IGRlbHRhRWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChgY2F1Y2lvbi0ke2R9ZC1kZWx0YWApOwogICAgICBzZXRDYXVjaW9uRGVsdGFDbGFzcyhkZWx0YUVsLCByb3cgPyByb3cuZGVsdGEgOiBudWxsKTsKICAgIH0pOwogICAgY29uc3QgdGVhMzAgPSB0bmFUb1RlYVBlcmNlbnQoYnlEYXlzWzMwXSAmJiBieURheXNbMzBdLnRuYSAhPT0gbnVsbCA/IGJ5RGF5c1szMF0udG5hIDogbnVsbCk7CiAgICBzZXRUZXh0KCdjYXVjaW9uLXRlYS0zMGQnLCBmb3JtYXRQZXJjZW50KHRlYTMwLCAxKSwgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHN0YXRlLmxhdGVzdC5jYXVjaW9uMWQgPSBieURheXNbMV0gPyBieURheXNbMV0udG5hIDogbnVsbDsKICB9CgogIGZ1bmN0aW9uIHJlbmRlckJvbm9zKHBheWxvYWQpIHsKICAgIGlmICghcGF5bG9hZCkgewogICAgICBCT05PX1RJQ0tFUlMuZm9yRWFjaCgodCkgPT4gc2V0RGFzaChbYGJvbm8tJHt0fS10aXJgLCBgYm9uby0ke3R9LXByZWNpb2AsIGBib25vLSR7dH0tdmFyYF0pKTsKICAgICAgc3RhdGUubGF0ZXN0LmFsMzBUaXIgPSBudWxsOwogICAgICByZXR1cm47CiAgICB9CiAgICBjb25zdCBkYXRhID0gZXh0cmFjdFJvb3QocGF5bG9hZCk7CiAgICBjb25zdCBsaXN0ID0gYXNBcnJheShkYXRhLmJvbm9zIHx8IGRhdGEpOwoKICAgIEJPTk9fVElDS0VSUy5mb3JFYWNoKCh0aWNrZXIpID0+IHsKICAgICAgY29uc3QgaXRlbSA9IGxpc3QuZmluZCgocm93KSA9PiB7CiAgICAgICAgY29uc3QgaWQgPSBub3JtYWxpemVUaWNrZXIocm93Py50aWNrZXIgfHwgcm93Py5zaW1ib2xvIHx8IHJvdz8uc3ltYm9sIHx8IHJvdz8uYm9ubyB8fCByb3c/Lm5vbWJyZSk7CiAgICAgICAgcmV0dXJuIGlkLmluY2x1ZGVzKHRpY2tlcik7CiAgICAgIH0pIHx8IGRhdGFbdGlja2VyXSB8fCBkYXRhW3RpY2tlci50b0xvd2VyQ2FzZSgpXSB8fCBudWxsOwogICAgICBjb25zdCB0aXIgPSB0b051bWJlcihpdGVtPy50aXIgPz8gaXRlbT8ueWllbGQgPz8gaXRlbT8ueXRtKTsKICAgICAgY29uc3QgcHJlY2lvID0gdG9OdW1iZXIoaXRlbT8ucHJlY2lvID8/IGl0ZW0/LnByaWNlID8/IGl0ZW0/LnVsdGltbyA/PyBpdGVtPy5sYXN0KTsKICAgICAgY29uc3QgdmFyaWFjaW9uID0gdG9OdW1iZXIoaXRlbT8udmFyaWFjaW9uID8/IGl0ZW0/LnZhciA/PyBpdGVtPy5jaGFuZ2UgPz8gaXRlbT8uZGFpbHlfY2hhbmdlKTsKICAgICAgc2V0VGV4dChgYm9uby0ke3RpY2tlcn0tdGlyYCwgZm9ybWF0UGVyY2VudCh0aXIsIDEpLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgICBzZXRUZXh0KGBib25vLSR7dGlja2VyfS1wcmVjaW9gLCBwcmVjaW8gPT09IG51bGwgPyAn4oCUJyA6IHByZWNpby50b0ZpeGVkKDIpLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgICBzZXRUZXh0KGBib25vLSR7dGlja2VyfS12YXJgLCB2YXJpYWNpb24gPT09IG51bGwgPyAn4oCUJyA6ICh2YXJpYWNpb24gPiAwID8gJysnIDogJycpICsgdmFyaWFjaW9uLnRvRml4ZWQoMSkgKyAnJScsIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICAgIGNvbnN0IHZhckVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoYGJvbm8tJHt0aWNrZXJ9LXZhcmApOwogICAgICBzZXRWYXJDbGFzcyh2YXJFbCwgdmFyaWFjaW9uKTsKICAgICAgaWYgKHRpY2tlciA9PT0gJ0FMMzAnKSBzdGF0ZS5sYXRlc3QuYWwzMFRpciA9IHRpcjsKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyTGV0cmFzKHBheWxvYWQpIHsKICAgIGlmICghcGF5bG9hZCkgewogICAgICBMRVRSQV9ST1dTLmZvckVhY2goKHJvdykgPT4gc2V0RGFzaChbYGxldHJhLSR7cm93LmlkfS10bmFgLCBgbGV0cmEtJHtyb3cuaWR9LXRlYWAsIGBsZXRyYS0ke3Jvdy5pZH0tdnRvYF0pKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgY29uc3QgZGF0YSA9IGV4dHJhY3RSb290KHBheWxvYWQpOwogICAgY29uc3QgbGlzdCA9IGFzQXJyYXkoZGF0YS5sZXRyYXMgfHwgZGF0YSk7CiAgICBMRVRSQV9ST1dTLmZvckVhY2goKHJvdykgPT4gewogICAgICBjb25zdCBpdGVtID0gbGlzdC5maW5kKChpdCkgPT4gewogICAgICAgIGNvbnN0IHRleHQgPSBub3JtYWxpemVUaWNrZXIoaXQ/LnRpY2tlciB8fCBpdD8uc2ltYm9sbyB8fCBpdD8uc3ltYm9sIHx8IGl0Py5ub21icmUgfHwgaXQ/LmRlc2NyaXBjaW9uKTsKICAgICAgICByZXR1cm4gcm93Lm1hdGNoLmV2ZXJ5KCh0b2tlbikgPT4gdGV4dC5pbmNsdWRlcyh0b2tlbikpOwogICAgICB9KSB8fCBkYXRhW3Jvdy5pZF0gfHwgZGF0YVtyb3cuaWQudG9Mb3dlckNhc2UoKV0gfHwgbnVsbDsKCiAgICAgIC8vIEFzdW1vIGNvbnRyYXRvIGZsZXhpYmxlOiBsYSBBUEkgcHVlZGUgdHJhZXIgdGFzYSBlbiAidG5hIiBvICJ0ZW0iIHNlZ8O6biBpbnN0cnVtZW50by4KICAgICAgY29uc3QgdG5hID0gdG9OdW1iZXIoaXRlbT8udG5hID8/IGl0ZW0/LnRhc2Ffbm9taW5hbCA/PyBpdGVtPy5yYXRlKTsKICAgICAgY29uc3QgdGVtID0gdG9OdW1iZXIoaXRlbT8udGVtID8/IGl0ZW0/LnRhc2FfZWZlY3RpdmFfbWVuc3VhbCk7CiAgICAgIGNvbnN0IHRlYUFwaSA9IHRvTnVtYmVyKGl0ZW0/LnRlYSk7CiAgICAgIGNvbnN0IHRlYSA9IHRlYUFwaSAhPT0gbnVsbCA/IHRlYUFwaSA6ICh0ZW0gIT09IG51bGwgPyB0ZW1Ub1RlYVBlcmNlbnQodGVtKSA6IHRuYVRvVGVhUGVyY2VudCh0bmEpKTsKICAgICAgY29uc3QgcmF0ZVZhbCA9IHJvdy5tb2RlID09PSAnVEVNJyA/ICh0ZW0gIT09IG51bGwgPyB0ZW0gOiB0bmEpIDogdG5hOwogICAgICBjb25zdCB2ZW5jID0gaXRlbT8udnRvID8/IGl0ZW0/LnZlbmNpbWllbnRvID8/IGl0ZW0/LmZlY2hhX3Z0byA/PyBpdGVtPy5tYXR1cml0eSA/PyBudWxsOwoKICAgICAgc2V0VGV4dChgbGV0cmEtJHtyb3cuaWR9LXRuYWAsIGZvcm1hdFBlcmNlbnQocmF0ZVZhbCwgMSksIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICAgIHNldFRleHQoYGxldHJhLSR7cm93LmlkfS10ZWFgLCBmb3JtYXRQZXJjZW50KHRlYSwgMSksIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICAgIHNldFRleHQoYGxldHJhLSR7cm93LmlkfS12dG9gLCB2ZW5jID8gYFZ0bzogJHtTdHJpbmcodmVuYyl9YCA6ICfigJQnLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgfSk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJDb250ZXh0Qm94KCkgewogICAgY29uc3QgYm94ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NvbnRleHQtYm94Jyk7CiAgICBpZiAoIWJveCkgcmV0dXJuOwogICAgY29uc3QgYzEgPSBzdGF0ZS5sYXRlc3QuY2F1Y2lvbjFkOwogICAgY29uc3QgYWwzMCA9IHN0YXRlLmxhdGVzdC5hbDMwVGlyOwogICAgY29uc3QgYiA9IHN0YXRlLmxhdGVzdC5icmVjaGFQY3Q7CiAgICBpZiAoYzEgPT09IG51bGwgfHwgYWwzMCA9PT0gbnVsbCB8fCBiID09PSBudWxsKSB7CiAgICAgIGJveC5pbm5lckhUTUwgPSAn8J+SoSA8c3Ryb25nPkNvbnRleHRvOjwvc3Ryb25nPiBEYXRvcyBpbmNvbXBsZXRvcyBwYXJhIGdlbmVyYXIgdW5hIGxlY3R1cmEgY3J1emFkYS4nOwogICAgICByZXR1cm47CiAgICB9CiAgICBjb25zdCBhY2Npb24gPSBiIDw9IFNJTUlMQVJfUENUX1RIUkVTSE9MRAogICAgICA/ICdzdWdpZXJlIHBhcmlkYWQgb3BlcmF0aXZhIHkgdmVudGFuYSBwYXJhIGFyYml0cmFqZSB0w6FjdGljbyBkZSBjb3J0byBwbGF6by4nCiAgICAgIDogJ211ZXN0cmEgZGVzYWNvcGxlLCBjb252aWVuZSBjYXV0ZWxhIHkgcHJpb3JpemFyIGNvYmVydHVyYSBoYXN0YSBub3JtYWxpemFjacOzbi4nOwogICAgYm94LmlubmVySFRNTCA9IGDwn5KhIDxzdHJvbmc+Q29udGV4dG86PC9zdHJvbmc+IENvbiBjYXVjacOzbiAxZCBlbiA8c3Ryb25nPiR7Zm9ybWF0UGVyY2VudChjMSwgMSl9IFROQTwvc3Ryb25nPiwgQUwzMCBlbiA8c3Ryb25nPiR7Zm9ybWF0UGVyY2VudChhbDMwLCAxKX0gVElSPC9zdHJvbmc+IHkgYnJlY2hhIE1FUC9DQ0wgZW4gPHN0cm9uZz4ke2Zvcm1hdFBlcmNlbnQoYiwgMil9PC9zdHJvbmc+LCBlbCBlc2NlbmFyaW8gJHthY2Npb259YDsKICB9CgogIGZ1bmN0aW9uIHJlbmRlck1ldHJpY3MyNGgocGF5bG9hZCkgewogICAgY29uc3QgZGF0YSA9IGV4dHJhY3RSb290KHBheWxvYWQpOwogICAgY29uc3QgbWV0cmljcyA9IGRhdGEgJiYgdHlwZW9mIGRhdGEubWV0cmljczI0aCA9PT0gJ29iamVjdCcgPyBkYXRhLm1ldHJpY3MyNGggOiBudWxsOwogICAgc2V0VGV4dCgnbWV0cmljLWNvdW50LTI0aCcsIG1ldHJpY3MgPyBTdHJpbmcobWV0cmljcy5jb3VudCA/PyAn4oCUJykgOiAn4oCUJywgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ21ldHJpYy1zaW1pbGFyLTI0aCcsIG1ldHJpY3MgPyBTdHJpbmcobWV0cmljcy5zaW1pbGFyQ291bnQgPz8gJ+KAlCcpIDogJ+KAlCcsIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWluLTI0aCcsIG1ldHJpY3MgJiYgbWV0cmljcy5taW5QY3QgIT0gbnVsbCA/IGZvcm1hdFBlcmNlbnQodG9OdW1iZXIobWV0cmljcy5taW5QY3QpLCAyKSA6ICfigJQnLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc2V0VGV4dCgnbWV0cmljLW1heC0yNGgnLCBtZXRyaWNzICYmIG1ldHJpY3MubWF4UGN0ICE9IG51bGwgPyBmb3JtYXRQZXJjZW50KHRvTnVtYmVyKG1ldHJpY3MubWF4UGN0KSwgMikgOiAn4oCUJywgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICB9CgogIGZ1bmN0aW9uIHJvd0hvdXJMYWJlbChlcG9jaCkgewogICAgY29uc3QgbiA9IHRvTnVtYmVyKGVwb2NoKTsKICAgIGlmIChuID09PSBudWxsKSByZXR1cm4gJ+KAlCc7CiAgICByZXR1cm4gZm10QXJnSG91ci5mb3JtYXQobmV3IERhdGUobiAqIDEwMDApKTsKICB9CgogIGZ1bmN0aW9uIHJlbmRlckhpc3RvcnkocGF5bG9hZCkgewogICAgY29uc3QgdGJvZHkgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGlzdG9yeS1yb3dzJyk7CiAgICBjb25zdCBjYXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGlzdG9yeS1jYXAnKTsKICAgIGlmICghdGJvZHkpIHJldHVybjsKICAgIGNvbnN0IGRhdGEgPSBleHRyYWN0Um9vdChwYXlsb2FkKTsKICAgIGNvbnN0IGhpc3RvcnkgPSBBcnJheS5pc0FycmF5KGRhdGEuaGlzdG9yeSkgPyBkYXRhLmhpc3Rvcnkuc2xpY2UoKSA6IFtdOwogICAgY29uc3Qgcm93cyA9IGhpc3Rvcnkuc2xpY2UoLUhJU1RPUllfUk9XU19MSU1JVCkucmV2ZXJzZSgpOwogICAgaWYgKGNhcCkgY2FwLnRleHRDb250ZW50ID0gYMOabHRpbWFzICR7cm93cy5sZW5ndGh9IG11ZXN0cmFzYDsKICAgIGlmICghcm93cy5sZW5ndGgpIHsKICAgICAgdGJvZHkuaW5uZXJIVE1MID0gJzx0cj48dGQgY2xhc3M9ImRpbSIgY29sc3Bhbj0iNiI+U2luIHJlZ2lzdHJvcyB0b2RhdsOtYTwvdGQ+PC90cj4nOwogICAgICByZXR1cm47CiAgICB9CiAgICB0Ym9keS5pbm5lckhUTUwgPSByb3dzLm1hcCgocikgPT4gewogICAgICBjb25zdCBtZXAgPSB0b051bWJlcihyLm1lcCk7CiAgICAgIGNvbnN0IGNjbCA9IHRvTnVtYmVyKHIuY2NsKTsKICAgICAgY29uc3QgYWJzID0gdG9OdW1iZXIoci5hYnNfZGlmZik7CiAgICAgIGNvbnN0IHBjdCA9IHRvTnVtYmVyKHIucGN0X2RpZmYpOwogICAgICBjb25zdCBzaW0gPSBCb29sZWFuKHIuc2ltaWxhcik7CiAgICAgIHJldHVybiBgPHRyPgogICAgICAgIDx0ZCBjbGFzcz0iZGltIj4ke3Jvd0hvdXJMYWJlbChyLmVwb2NoKX08L3RkPgogICAgICAgIDx0ZCBzdHlsZT0iY29sb3I6dmFyKC0tbWVwKSI+JHtmb3JtYXRNb25leShtZXAsIDIpfTwvdGQ+CiAgICAgICAgPHRkIHN0eWxlPSJjb2xvcjp2YXIoLS1jY2wpIj4ke2Zvcm1hdE1vbmV5KGNjbCwgMil9PC90ZD4KICAgICAgICA8dGQ+JHtmb3JtYXRNb25leShhYnMsIDIpfTwvdGQ+CiAgICAgICAgPHRkPiR7Zm9ybWF0UGVyY2VudChwY3QsIDIpfTwvdGQ+CiAgICAgICAgPHRkPjxzcGFuIGNsYXNzPSJzYmFkZ2UgJHtzaW0gPyAnc2ltJyA6ICdub3NpbSd9Ij4ke3NpbSA/ICdTaW1pbGFyJyA6ICdObyBzaW1pbGFyJ308L3NwYW4+PC90ZD4KICAgICAgPC90cj5gOwogICAgfSkuam9pbignJyk7CiAgfQoKICBmdW5jdGlvbiBsaW5lUG9pbnRzKHZhbHVlcywgeDAsIHgxLCB5MCwgeTEpIHsKICAgIGlmICghdmFsdWVzLmxlbmd0aCkgcmV0dXJuICcnOwogICAgY29uc3QgbWluID0gTWF0aC5taW4oLi4udmFsdWVzKTsKICAgIGNvbnN0IG1heCA9IE1hdGgubWF4KC4uLnZhbHVlcyk7CiAgICBjb25zdCBzcGFuID0gTWF0aC5tYXgoMC4wMDAwMDEsIG1heCAtIG1pbik7CiAgICByZXR1cm4gdmFsdWVzLm1hcCgodiwgaSkgPT4gewogICAgICBjb25zdCB4ID0geDAgKyAoKHgxIC0geDApICogaSAvIE1hdGgubWF4KDEsIHZhbHVlcy5sZW5ndGggLSAxKSk7CiAgICAgIGNvbnN0IHkgPSB5MSAtICgodiAtIG1pbikgLyBzcGFuKSAqICh5MSAtIHkwKTsKICAgICAgcmV0dXJuIGAke3gudG9GaXhlZCgyKX0sJHt5LnRvRml4ZWQoMil9YDsKICAgIH0pLmpvaW4oJyAnKTsKICB9CgogIGZ1bmN0aW9uIHJlbmRlclRyZW5kKHBheWxvYWQpIHsKICAgIGNvbnN0IGRhdGEgPSBleHRyYWN0Um9vdChwYXlsb2FkKTsKICAgIGNvbnN0IGhpc3RvcnkgPSBBcnJheS5pc0FycmF5KGRhdGEuaGlzdG9yeSkgPyBkYXRhLmhpc3Rvcnkuc2xpY2UoLVRSRU5EX1BPSU5UUykgOiBbXTsKICAgIGNvbnN0IG1lcExpbmUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtbWVwLWxpbmUnKTsKICAgIGNvbnN0IGNjbExpbmUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtY2NsLWxpbmUnKTsKICAgIGNvbnN0IGdhcExpbmUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtZ2FwLWxpbmUnKTsKICAgIGlmICghbWVwTGluZSB8fCAhY2NsTGluZSB8fCAhZ2FwTGluZSkgcmV0dXJuOwogICAgaWYgKCFoaXN0b3J5Lmxlbmd0aCkgewogICAgICBtZXBMaW5lLnNldEF0dHJpYnV0ZSgncG9pbnRzJywgJycpOwogICAgICBjY2xMaW5lLnNldEF0dHJpYnV0ZSgncG9pbnRzJywgJycpOwogICAgICBnYXBMaW5lLnNldEF0dHJpYnV0ZSgncG9pbnRzJywgJycpOwogICAgICBbJ3RyZW5kLXktdG9wJywgJ3RyZW5kLXktbWlkJywgJ3RyZW5kLXktbG93JywgJ3RyZW5kLXgtMScsICd0cmVuZC14LTInLCAndHJlbmQteC0zJywgJ3RyZW5kLXgtNCcsICd0cmVuZC14LTUnXS5mb3JFYWNoKChpZCkgPT4gc2V0VGV4dChpZCwgJ+KAlCcpKTsKICAgICAgcmV0dXJuOwogICAgfQoKICAgIGNvbnN0IG1lcFZhbHMgPSBoaXN0b3J5Lm1hcCgocikgPT4gdG9OdW1iZXIoci5tZXApKS5maWx0ZXIoKHYpID0+IHYgIT0gbnVsbCk7CiAgICBjb25zdCBjY2xWYWxzID0gaGlzdG9yeS5tYXAoKHIpID0+IHRvTnVtYmVyKHIuY2NsKSkuZmlsdGVyKCh2KSA9PiB2ICE9IG51bGwpOwogICAgY29uc3QgZ2FwVmFscyA9IGhpc3RvcnkubWFwKChyKSA9PiB0b051bWJlcihyLnBjdF9kaWZmKSkuZmlsdGVyKCh2KSA9PiB2ICE9IG51bGwpOwogICAgaWYgKCFtZXBWYWxzLmxlbmd0aCB8fCAhY2NsVmFscy5sZW5ndGgpIHJldHVybjsKCiAgICBtZXBMaW5lLnNldEF0dHJpYnV0ZSgncG9pbnRzJywgbGluZVBvaW50cyhtZXBWYWxzLCAzMCwgODQwLCAyNSwgMTMwKSk7CiAgICBjY2xMaW5lLnNldEF0dHJpYnV0ZSgncG9pbnRzJywgbGluZVBvaW50cyhjY2xWYWxzLCAzMCwgODQwLCAyNSwgMTMwKSk7CiAgICBnYXBMaW5lLnNldEF0dHJpYnV0ZSgncG9pbnRzJywgbGluZVBvaW50cyhnYXBWYWxzLmxlbmd0aCA/IGdhcFZhbHMgOiBbMF0sIDMwLCA4NDAsIDM1LCA2MikpOwoKICAgIGNvbnN0IGFsbCA9IG1lcFZhbHMuY29uY2F0KGNjbFZhbHMpOwogICAgY29uc3QgbWluID0gTWF0aC5taW4oLi4uYWxsKTsKICAgIGNvbnN0IG1heCA9IE1hdGgubWF4KC4uLmFsbCk7CiAgICBjb25zdCBtaWQgPSAobWluICsgbWF4KSAvIDI7CiAgICBzZXRUZXh0KCd0cmVuZC15LXRvcCcsIChtYXggLyAxMDAwKS50b0ZpeGVkKDMpKTsKICAgIHNldFRleHQoJ3RyZW5kLXktbWlkJywgKG1pZCAvIDEwMDApLnRvRml4ZWQoMykpOwogICAgc2V0VGV4dCgndHJlbmQteS1sb3cnLCAobWluIC8gMTAwMCkudG9GaXhlZCgzKSk7CgogICAgY29uc3QgaWR4ID0gWzAsIDAuMjUsIDAuNSwgMC43NSwgMV0ubWFwKChwKSA9PiBNYXRoLm1pbihoaXN0b3J5Lmxlbmd0aCAtIDEsIE1hdGguZmxvb3IoKGhpc3RvcnkubGVuZ3RoIC0gMSkgKiBwKSkpOwogICAgY29uc3QgbGFicyA9IGlkeC5tYXAoKGkpID0+IHJvd0hvdXJMYWJlbChoaXN0b3J5W2ldPy5lcG9jaCkpOwogICAgc2V0VGV4dCgndHJlbmQteC0xJywgbGFic1swXSB8fCAn4oCUJyk7CiAgICBzZXRUZXh0KCd0cmVuZC14LTInLCBsYWJzWzFdIHx8ICfigJQnKTsKICAgIHNldFRleHQoJ3RyZW5kLXgtMycsIGxhYnNbMl0gfHwgJ+KAlCcpOwogICAgc2V0VGV4dCgndHJlbmQteC00JywgbGFic1szXSB8fCAn4oCUJyk7CiAgICBzZXRUZXh0KCd0cmVuZC14LTUnLCBsYWJzWzRdIHx8ICfigJQnKTsKICB9CgogIC8vIDQpIEZ1bmNpw7NuIGNlbnRyYWwgZmV0Y2hBbGwoKQogIGFzeW5jIGZ1bmN0aW9uIGZldGNoSnNvbih1cmwpIHsKICAgIGNvbnN0IGN0cmwgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7CiAgICBjb25zdCB0aW1lb3V0ID0gc2V0VGltZW91dCgoKSA9PiBjdHJsLmFib3J0KCksIDEyMDAwKTsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKHVybCwgeyBjYWNoZTogJ25vLXN0b3JlJywgc2lnbmFsOiBjdHJsLnNpZ25hbCB9KTsKICAgICAgaWYgKCFyZXMub2spIHRocm93IG5ldyBFcnJvcihgSFRUUCAke3Jlcy5zdGF0dXN9YCk7CiAgICAgIHJldHVybiBhd2FpdCByZXMuanNvbigpOwogICAgfSBmaW5hbGx5IHsKICAgICAgY2xlYXJUaW1lb3V0KHRpbWVvdXQpOwogICAgfQogIH0KCiAgYXN5bmMgZnVuY3Rpb24gZmV0Y2hBbGwob3B0aW9ucyA9IHt9KSB7CiAgICBpZiAoc3RhdGUuaXNGZXRjaGluZykgcmV0dXJuOwogICAgc3RhdGUuaXNGZXRjaGluZyA9IHRydWU7CiAgICBzZXRMb2FkaW5nKE5VTUVSSUNfSURTLCB0cnVlKTsKICAgIHNldEZyZXNoQmFkZ2UoJ0FjdHVhbGl6YW5kb+KApicsICdmZXRjaGluZycpOwogICAgc2V0RXJyb3JCYW5uZXIoZmFsc2UpOwogICAgdHJ5IHsKICAgICAgY29uc3QgdGFza3MgPSBbCiAgICAgICAgWydtZXBDY2wnLCBFTkRQT0lOVFMubWVwQ2NsXSwKICAgICAgICBbJ2NhdWNpb25lcycsIEVORFBPSU5UUy5jYXVjaW9uZXNdLAogICAgICAgIFsnYm9ub3MnLCBFTkRQT0lOVFMuYm9ub3NdLAogICAgICAgIFsnbGV0cmFzJywgRU5EUE9JTlRTLmxldHJhc10KICAgICAgXTsKCiAgICAgIGNvbnN0IHNldHRsZWQgPSBhd2FpdCBQcm9taXNlLmFsbFNldHRsZWQodGFza3MubWFwKGFzeW5jIChbbmFtZSwgdXJsXSkgPT4gewogICAgICAgIHRyeSB7CiAgICAgICAgICBjb25zdCBkYXRhID0gYXdhaXQgZmV0Y2hKc29uKHVybCk7CiAgICAgICAgICByZXR1cm4geyBuYW1lLCBkYXRhIH07CiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHsKICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYFtSYWRhck1FUF0gZXJyb3IgZW4gJHtuYW1lfWAsIGVycm9yKTsKICAgICAgICAgIHRocm93IHsgbmFtZSwgZXJyb3IgfTsKICAgICAgICB9CiAgICAgIH0pKTsKCiAgICAgIGNvbnN0IGJhZyA9IHsgdGltZXN0YW1wOiBEYXRlLm5vdygpLCBtZXBDY2w6IG51bGwsIGNhdWNpb25lczogbnVsbCwgYm9ub3M6IG51bGwsIGxldHJhczogbnVsbCB9OwogICAgICBjb25zdCBmYWlsZWQgPSBbXTsKICAgICAgc2V0dGxlZC5mb3JFYWNoKChyLCBpZHgpID0+IHsKICAgICAgICBjb25zdCBuYW1lID0gdGFza3NbaWR4XVswXTsKICAgICAgICBpZiAoci5zdGF0dXMgPT09ICdmdWxmaWxsZWQnKSBiYWdbbmFtZV0gPSByLnZhbHVlLmRhdGE7CiAgICAgICAgZWxzZSBmYWlsZWQucHVzaChuYW1lKTsKICAgICAgfSk7CgogICAgICByZW5kZXJNZXBDY2woYmFnLm1lcENjbCk7CiAgICAgIHJlbmRlck1ldHJpY3MyNGgoYmFnLm1lcENjbCk7CiAgICAgIHJlbmRlclRyZW5kKGJhZy5tZXBDY2wpOwogICAgICByZW5kZXJIaXN0b3J5KGJhZy5tZXBDY2wpOwogICAgICByZW5kZXJDYXVjaW9uZXMoYmFnLmNhdWNpb25lcyk7CiAgICAgIHJlbmRlckJvbm9zKGJhZy5ib25vcyk7CiAgICAgIHJlbmRlckxldHJhcyhiYWcubGV0cmFzKTsKICAgICAgcmVuZGVyQ29udGV4dEJveCgpOwogICAgICBjb25zdCBtZXBSb290ID0gZXh0cmFjdFJvb3QoYmFnLm1lcENjbCk7CiAgICAgIGNvbnN0IHVwZGF0ZWRBcnQgPSB0eXBlb2YgbWVwUm9vdD8udXBkYXRlZEF0SHVtYW5BcnQgPT09ICdzdHJpbmcnID8gbWVwUm9vdC51cGRhdGVkQXRIdW1hbkFydCA6IG51bGw7CiAgICAgIGNvbnN0IHNvdXJjZUZyZXNoID0gdHlwZW9mIG1lcFJvb3Q/LnNvdXJjZVN0YXR1cz8uZnJlc2hMYWJlbCA9PT0gJ3N0cmluZycgPyBtZXBSb290LnNvdXJjZVN0YXR1cy5mcmVzaExhYmVsIDogbnVsbDsKICAgICAgc2V0VGV4dCgnbGFzdC1ydW4tdGltZScsIHVwZGF0ZWRBcnQgfHwgZm10QXJnVGltZVNlYy5mb3JtYXQobmV3IERhdGUoKSkpOwoKICAgICAgY29uc3Qgc3VjY2Vzc0NvdW50ID0gdGFza3MubGVuZ3RoIC0gZmFpbGVkLmxlbmd0aDsKICAgICAgaWYgKHN1Y2Nlc3NDb3VudCA+IDApIHsKICAgICAgICBzdGF0ZS5sYXN0U3VjY2Vzc0F0ID0gRGF0ZS5ub3coKTsKICAgICAgICBzdGF0ZS5yZXRyeUluZGV4ID0gMDsKICAgICAgICBpZiAoc3RhdGUucmV0cnlUaW1lcikgY2xlYXJUaW1lb3V0KHN0YXRlLnJldHJ5VGltZXIpOwogICAgICAgIHNhdmVDYWNoZShiYWcpOwogICAgICAgIGNvbnN0IGJhZGdlQmFzZSA9IHNvdXJjZUZyZXNoID8gYEZ1ZW50ZSAke3NvdXJjZUZyZXNofWAgOiBgQWN0dWFsaXphZG8gwrcgJHtmbXRBcmdUaW1lLmZvcm1hdChuZXcgRGF0ZSgpKX1gOwogICAgICAgIGlmIChmYWlsZWQubGVuZ3RoKSBzZXRGcmVzaEJhZGdlKGBBY3R1YWxpemFjacOzbiBwYXJjaWFsIMK3ICR7YmFkZ2VCYXNlfWAsICdpZGxlJyk7CiAgICAgICAgZWxzZSBzZXRGcmVzaEJhZGdlKGJhZGdlQmFzZSwgJ2lkbGUnKTsKICAgICAgfSBlbHNlIHsKICAgICAgICBjb25zdCBhdHRlbXB0ID0gc3RhdGUucmV0cnlJbmRleCArIDE7CiAgICAgICAgaWYgKHN0YXRlLnJldHJ5SW5kZXggPCBSRVRSWV9ERUxBWVMubGVuZ3RoKSB7CiAgICAgICAgICBjb25zdCBkZWxheSA9IFJFVFJZX0RFTEFZU1tzdGF0ZS5yZXRyeUluZGV4XTsKICAgICAgICAgIHN0YXRlLnJldHJ5SW5kZXggKz0gMTsKICAgICAgICAgIHNldEZyZXNoQmFkZ2UoYEVycm9yIMK3IFJlaW50ZW50byBlbiAke01hdGgucm91bmQoZGVsYXkgLyAxMDAwKX1zYCwgJ2Vycm9yJyk7CiAgICAgICAgICBpZiAoc3RhdGUucmV0cnlUaW1lcikgY2xlYXJUaW1lb3V0KHN0YXRlLnJldHJ5VGltZXIpOwogICAgICAgICAgc3RhdGUucmV0cnlUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gZmV0Y2hBbGwoeyBtYW51YWw6IHRydWUgfSksIGRlbGF5KTsKICAgICAgICB9IGVsc2UgewogICAgICAgICAgc2V0RnJlc2hCYWRnZSgnRXJyb3IgwrcgUmVpbnRlbnRhcicsICdlcnJvcicpOwogICAgICAgICAgc2V0RXJyb3JCYW5uZXIodHJ1ZSwgJ0Vycm9yIGFsIGFjdHVhbGl6YXIgwrcgUmVpbnRlbnRhcicpOwogICAgICAgICAgY29uc29sZS5lcnJvcihgW1JhZGFyTUVQXSBzZSBhZ290YXJvbiByZXRyaWVzICgke2F0dGVtcHR9IGludGVudG9zKWApOwogICAgICAgICAgaWYgKHdpbmRvdy5zY2hlZHVsZXIpIHdpbmRvdy5zY2hlZHVsZXIuc3RvcCgpOwogICAgICAgIH0KICAgICAgfQogICAgfSBmaW5hbGx5IHsKICAgICAgc2V0TG9hZGluZyhOVU1FUklDX0lEUywgZmFsc2UpOwogICAgICBzdGF0ZS5pc0ZldGNoaW5nID0gZmFsc2U7CiAgICB9CiAgfQoKICAvLyA1KSBDbGFzZSBNYXJrZXRTY2hlZHVsZXIKICBjbGFzcyBNYXJrZXRTY2hlZHVsZXIgewogICAgY29uc3RydWN0b3IoZmV0Y2hGbiwgaW50ZXJ2YWxNcyA9IDMwMDAwMCkgewogICAgICB0aGlzLmZldGNoRm4gPSBmZXRjaEZuOwogICAgICB0aGlzLmludGVydmFsTXMgPSBpbnRlcnZhbE1zOwogICAgICB0aGlzLnRpbWVyID0gbnVsbDsKICAgICAgdGhpcy53YWl0VGltZXIgPSBudWxsOwogICAgICB0aGlzLmNvdW50ZG93blRpbWVyID0gbnVsbDsKICAgICAgdGhpcy5uZXh0UnVuQXQgPSBudWxsOwogICAgICB0aGlzLnJ1bm5pbmcgPSBmYWxzZTsKICAgICAgdGhpcy5wYXVzZWQgPSBmYWxzZTsKICAgIH0KCiAgICBzdGFydCgpIHsKICAgICAgaWYgKHRoaXMucnVubmluZykgcmV0dXJuOwogICAgICB0aGlzLnJ1bm5pbmcgPSB0cnVlOwogICAgICB0aGlzLnBhdXNlZCA9IGZhbHNlOwogICAgICBpZiAodGhpcy5pc01hcmtldE9wZW4oKSkgewogICAgICAgIHNldE1hcmtldFRhZyh0cnVlKTsKICAgICAgICB0aGlzLl9zY2hlZHVsZSh0aGlzLmludGVydmFsTXMpOwogICAgICB9IGVsc2UgewogICAgICAgIHNldE1hcmtldFRhZyhmYWxzZSk7CiAgICAgICAgdGhpcy5fd2FpdEZvck9wZW4oKTsKICAgICAgfQogICAgICB0aGlzLl9zdGFydENvdW50ZG93bigpOwogICAgfQoKICAgIHBhdXNlKCkgewogICAgICB0aGlzLnBhdXNlZCA9IHRydWU7CiAgICAgIGNsZWFyVGltZW91dCh0aGlzLnRpbWVyKTsKICAgICAgY2xlYXJUaW1lb3V0KHRoaXMud2FpdFRpbWVyKTsKICAgICAgdGhpcy50aW1lciA9IG51bGw7CiAgICAgIHRoaXMud2FpdFRpbWVyID0gbnVsbDsKICAgICAgdGhpcy5fc3RvcENvdW50ZG93bigpOwogICAgICBjb25zdCBjb3VudGRvd24gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY291bnRkb3duLXRleHQnKTsKICAgICAgaWYgKGNvdW50ZG93bikgY291bnRkb3duLnRleHRDb250ZW50ID0gJ0FjdHVhbGl6YWNpw7NuIHBhdXNhZGEnOwogICAgfQoKICAgIHJlc3VtZSgpIHsKICAgICAgaWYgKCF0aGlzLnJ1bm5pbmcpIHRoaXMucnVubmluZyA9IHRydWU7CiAgICAgIHRoaXMucGF1c2VkID0gZmFsc2U7CiAgICAgIGNvbnN0IGNvbnRpbnVlUmVzdW1lID0gKCkgPT4gewogICAgICAgIGlmICh0aGlzLmlzTWFya2V0T3BlbigpKSB7CiAgICAgICAgICBzZXRNYXJrZXRUYWcodHJ1ZSk7CiAgICAgICAgICB0aGlzLl9zY2hlZHVsZSh0aGlzLmludGVydmFsTXMpOwogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICBzZXRNYXJrZXRUYWcoZmFsc2UpOwogICAgICAgICAgdGhpcy5fd2FpdEZvck9wZW4oKTsKICAgICAgICB9CiAgICAgICAgdGhpcy5fc3RhcnRDb3VudGRvd24oKTsKICAgICAgfTsKICAgICAgaWYgKERhdGUubm93KCkgLSBzdGF0ZS5sYXN0U3VjY2Vzc0F0ID4gdGhpcy5pbnRlcnZhbE1zKSB7CiAgICAgICAgUHJvbWlzZS5yZXNvbHZlKHRoaXMuZmV0Y2hGbih7IG1hbnVhbDogdHJ1ZSB9KSkuZmluYWxseShjb250aW51ZVJlc3VtZSk7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgY29udGludWVSZXN1bWUoKTsKICAgICAgfQogICAgfQoKICAgIHN0b3AoKSB7CiAgICAgIHRoaXMucnVubmluZyA9IGZhbHNlOwogICAgICB0aGlzLnBhdXNlZCA9IGZhbHNlOwogICAgICBjbGVhclRpbWVvdXQodGhpcy50aW1lcik7CiAgICAgIGNsZWFyVGltZW91dCh0aGlzLndhaXRUaW1lcik7CiAgICAgIHRoaXMudGltZXIgPSBudWxsOwogICAgICB0aGlzLndhaXRUaW1lciA9IG51bGw7CiAgICAgIHRoaXMubmV4dFJ1bkF0ID0gbnVsbDsKICAgICAgdGhpcy5fc3RvcENvdW50ZG93bigpOwogICAgfQoKICAgIGlzTWFya2V0T3BlbigpIHsKICAgICAgY29uc3QgcCA9IGdldEFyZ05vd1BhcnRzKCk7CiAgICAgIGNvbnN0IGJ1c2luZXNzRGF5ID0gcC53ZWVrZGF5ID49IDEgJiYgcC53ZWVrZGF5IDw9IDU7CiAgICAgIGNvbnN0IHNlY29uZHMgPSBwLmhvdXIgKiAzNjAwICsgcC5taW51dGUgKiA2MCArIHAuc2Vjb25kOwogICAgICBjb25zdCBmcm9tID0gMTAgKiAzNjAwICsgMzAgKiA2MDsKICAgICAgY29uc3QgdG8gPSAxOCAqIDM2MDA7CiAgICAgIHJldHVybiBidXNpbmVzc0RheSAmJiBzZWNvbmRzID49IGZyb20gJiYgc2Vjb25kcyA8IHRvOwogICAgfQoKICAgIGdldE5leHRSdW5UaW1lKCkgewogICAgICByZXR1cm4gdGhpcy5uZXh0UnVuQXQgPyBuZXcgRGF0ZSh0aGlzLm5leHRSdW5BdCkgOiBudWxsOwogICAgfQoKICAgIF9zY2hlZHVsZShkZWxheU1zKSB7CiAgICAgIGlmICghdGhpcy5ydW5uaW5nIHx8IHRoaXMucGF1c2VkKSByZXR1cm47CiAgICAgIGNsZWFyVGltZW91dCh0aGlzLnRpbWVyKTsKICAgICAgdGhpcy5uZXh0UnVuQXQgPSBEYXRlLm5vdygpICsgZGVsYXlNczsKICAgICAgdGhpcy50aW1lciA9IHNldFRpbWVvdXQoYXN5bmMgKCkgPT4gewogICAgICAgIGlmICghdGhpcy5ydW5uaW5nIHx8IHRoaXMucGF1c2VkKSByZXR1cm47CiAgICAgICAgaWYgKCF0aGlzLmlzTWFya2V0T3BlbigpKSB7CiAgICAgICAgICBzZXRNYXJrZXRUYWcoZmFsc2UpOwogICAgICAgICAgdGhpcy5fd2FpdEZvck9wZW4oKTsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgICAgc2V0TWFya2V0VGFnKHRydWUpOwogICAgICAgIGF3YWl0IHRoaXMuZmV0Y2hGbigpOwogICAgICAgIHRoaXMuX3NjaGVkdWxlKHRoaXMuaW50ZXJ2YWxNcyk7CiAgICAgIH0sIGRlbGF5TXMpOwogICAgfQoKICAgIF93YWl0Rm9yT3BlbigpIHsKICAgICAgaWYgKCF0aGlzLnJ1bm5pbmcgfHwgdGhpcy5wYXVzZWQpIHJldHVybjsKICAgICAgY2xlYXJUaW1lb3V0KHRoaXMud2FpdFRpbWVyKTsKICAgICAgdGhpcy5uZXh0UnVuQXQgPSBEYXRlLm5vdygpICsgNjAwMDA7CiAgICAgIHRoaXMud2FpdFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7CiAgICAgICAgaWYgKCF0aGlzLnJ1bm5pbmcgfHwgdGhpcy5wYXVzZWQpIHJldHVybjsKICAgICAgICBpZiAodGhpcy5pc01hcmtldE9wZW4oKSkgewogICAgICAgICAgc2V0TWFya2V0VGFnKHRydWUpOwogICAgICAgICAgdGhpcy5mZXRjaEZuKHsgbWFudWFsOiB0cnVlIH0pOwogICAgICAgICAgdGhpcy5fc2NoZWR1bGUodGhpcy5pbnRlcnZhbE1zKTsKICAgICAgICB9IGVsc2UgewogICAgICAgICAgc2V0TWFya2V0VGFnKGZhbHNlKTsKICAgICAgICAgIHRoaXMuX3dhaXRGb3JPcGVuKCk7CiAgICAgICAgfQogICAgICB9LCA2MDAwMCk7CiAgICB9CgogICAgX3N0YXJ0Q291bnRkb3duKCkgewogICAgICB0aGlzLl9zdG9wQ291bnRkb3duKCk7CiAgICAgIHRoaXMuY291bnRkb3duVGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7CiAgICAgICAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY291bnRkb3duLXRleHQnKTsKICAgICAgICBpZiAoIWVsIHx8IHRoaXMucGF1c2VkKSByZXR1cm47CiAgICAgICAgY29uc3QgbmV4dCA9IHRoaXMuZ2V0TmV4dFJ1blRpbWUoKTsKICAgICAgICBpZiAoIW5leHQpIHsKICAgICAgICAgIGVsLnRleHRDb250ZW50ID0gdGhpcy5pc01hcmtldE9wZW4oKSA/ICdQcsOzeGltYSBhY3R1YWxpemFjacOzbiBlbiDigJQnIDogJ01lcmNhZG8gY2VycmFkbyc7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQogICAgICAgIGNvbnN0IGRpZmYgPSBNYXRoLm1heCgwLCBuZXh0LmdldFRpbWUoKSAtIERhdGUubm93KCkpOwogICAgICAgIGNvbnN0IG0gPSBNYXRoLmZsb29yKGRpZmYgLyA2MDAwMCk7CiAgICAgICAgY29uc3QgcyA9IE1hdGguZmxvb3IoKGRpZmYgJSA2MDAwMCkgLyAxMDAwKTsKICAgICAgICBpZiAodGhpcy5pc01hcmtldE9wZW4oKSkgZWwudGV4dENvbnRlbnQgPSBgUHLDs3hpbWEgYWN0dWFsaXphY2nDs24gZW4gJHttfToke1N0cmluZyhzKS5wYWRTdGFydCgyLCAnMCcpfWA7CiAgICAgICAgZWxzZSBlbC50ZXh0Q29udGVudCA9ICdNZXJjYWRvIGNlcnJhZG8nOwogICAgICB9LCAxMDAwKTsKICAgIH0KCiAgICBfc3RvcENvdW50ZG93bigpIHsKICAgICAgY2xlYXJJbnRlcnZhbCh0aGlzLmNvdW50ZG93blRpbWVyKTsKICAgICAgdGhpcy5jb3VudGRvd25UaW1lciA9IG51bGw7CiAgICB9CiAgfQoKICAvLyA2KSBMw7NnaWNhIGRlIGNhY2jDqQogIGZ1bmN0aW9uIHNhdmVDYWNoZShkYXRhKSB7CiAgICB0cnkgewogICAgICBzZXNzaW9uU3RvcmFnZS5zZXRJdGVtKENBQ0hFX0tFWSwgSlNPTi5zdHJpbmdpZnkoewogICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSwKICAgICAgICBtZXBDY2w6IGRhdGEubWVwQ2NsLAogICAgICAgIGNhdWNpb25lczogZGF0YS5jYXVjaW9uZXMsCiAgICAgICAgYm9ub3M6IGRhdGEuYm9ub3MsCiAgICAgICAgbGV0cmFzOiBkYXRhLmxldHJhcwogICAgICB9KSk7CiAgICB9IGNhdGNoIChlKSB7CiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tSYWRhck1FUF0gbm8gc2UgcHVkbyBndWFyZGFyIGNhY2hlJywgZSk7CiAgICB9CiAgfQoKICBmdW5jdGlvbiBsb2FkQ2FjaGUoKSB7CiAgICB0cnkgewogICAgICBjb25zdCByYXcgPSBzZXNzaW9uU3RvcmFnZS5nZXRJdGVtKENBQ0hFX0tFWSk7CiAgICAgIGlmICghcmF3KSByZXR1cm4gbnVsbDsKICAgICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyYXcpOwogICAgICBpZiAoIXBhcnNlZC50aW1lc3RhbXAgfHwgRGF0ZS5ub3coKSAtIHBhcnNlZC50aW1lc3RhbXAgPiBDQUNIRV9UVExfTVMpIHJldHVybiBudWxsOwogICAgICByZXR1cm4gcGFyc2VkOwogICAgfSBjYXRjaCAoZSkgewogICAgICBjb25zb2xlLmVycm9yKCdbUmFkYXJNRVBdIGNhY2hlIGludsOhbGlkYScsIGUpOwogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICB9CgogIC8vIDcpIEluaWNpYWxpemFjacOzbgogIGZ1bmN0aW9uIHRvZ2dsZURyYXdlcigpIHsKICAgIGNvbnN0IGRyYXdlciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdkcmF3ZXInKTsKICAgIGNvbnN0IHdyYXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYm9keVdyYXAnKTsKICAgIGNvbnN0IGJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdidG5UYXNhcycpOwogICAgY29uc3Qgb3ZsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ292ZXJsYXknKTsKICAgIGNvbnN0IGlzT3BlbiA9IGRyYXdlci5jbGFzc0xpc3QuY29udGFpbnMoJ29wZW4nKTsKICAgIGRyYXdlci5jbGFzc0xpc3QudG9nZ2xlKCdvcGVuJywgIWlzT3Blbik7CiAgICB3cmFwLmNsYXNzTGlzdC50b2dnbGUoJ2RyYXdlci1vcGVuJywgIWlzT3Blbik7CiAgICBidG4uY2xhc3NMaXN0LnRvZ2dsZSgnYWN0aXZlJywgIWlzT3Blbik7CiAgICBvdmwuY2xhc3NMaXN0LnRvZ2dsZSgnc2hvdycsICFpc09wZW4pOwogIH0KCiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnBpbGwnKS5mb3JFYWNoKChwKSA9PiB7CiAgICBwLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcucGlsbCcpLmZvckVhY2goKHgpID0+IHguY2xhc3NMaXN0LnJlbW92ZSgnb24nKSk7CiAgICAgIHAuY2xhc3NMaXN0LmFkZCgnb24nKTsKICAgIH0pOwogIH0pOwoKICBmdW5jdGlvbiB0b2dnbGVHbG9zKCkgewogICAgY29uc3QgZ3JpZCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdnbG9zR3JpZCcpOwogICAgY29uc3QgYXJyb3cgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZ2xvc0Fycm93Jyk7CiAgICBjb25zdCBvcGVuID0gZ3JpZC5jbGFzc0xpc3QudG9nZ2xlKCdvcGVuJyk7CiAgICBhcnJvdy50ZXh0Q29udGVudCA9IG9wZW4gPyAn4pa0JyA6ICfilr4nOwogIH0KCiAgY29uc3QgcmV0cnlCdG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZXJyb3ItcmV0cnktYnRuJyk7CiAgaWYgKHJldHJ5QnRuKSB7CiAgICByZXRyeUJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgaWYgKHdpbmRvdy5zY2hlZHVsZXIpIHdpbmRvdy5zY2hlZHVsZXIucmVzdW1lKCk7CiAgICAgIGZldGNoQWxsKHsgbWFudWFsOiB0cnVlIH0pOwogICAgfSk7CiAgfQoKICBjb25zdCBjYWNoZWQgPSBsb2FkQ2FjaGUoKTsKICBpZiAoY2FjaGVkKSB7CiAgICByZW5kZXJNZXBDY2woY2FjaGVkLm1lcENjbCk7CiAgICByZW5kZXJNZXRyaWNzMjRoKGNhY2hlZC5tZXBDY2wpOwogICAgcmVuZGVyVHJlbmQoY2FjaGVkLm1lcENjbCk7CiAgICByZW5kZXJIaXN0b3J5KGNhY2hlZC5tZXBDY2wpOwogICAgcmVuZGVyQ2F1Y2lvbmVzKGNhY2hlZC5jYXVjaW9uZXMpOwogICAgcmVuZGVyQm9ub3MoY2FjaGVkLmJvbm9zKTsKICAgIHJlbmRlckxldHJhcyhjYWNoZWQubGV0cmFzKTsKICAgIHJlbmRlckNvbnRleHRCb3goKTsKICAgIHNldEZyZXNoQmFkZ2UoYERhdG8gZW4gY2FjaMOpIMK3ICR7Zm10QXJnVGltZS5mb3JtYXQobmV3IERhdGUoY2FjaGVkLnRpbWVzdGFtcCkpfWAsICdpZGxlJyk7CiAgfQoKICB3aW5kb3cuc2NoZWR1bGVyID0gbmV3IE1hcmtldFNjaGVkdWxlcihmZXRjaEFsbCwgRkVUQ0hfSU5URVJWQUxfTVMpOwogIHdpbmRvdy5zY2hlZHVsZXIuc3RhcnQoKTsKICBmZXRjaEFsbCh7IG1hbnVhbDogdHJ1ZSB9KTsKCiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcigndmlzaWJpbGl0eWNoYW5nZScsICgpID0+IHsKICAgIGlmIChkb2N1bWVudC5oaWRkZW4pIHdpbmRvdy5zY2hlZHVsZXIucGF1c2UoKTsKICAgIGVsc2Ugd2luZG93LnNjaGVkdWxlci5yZXN1bWUoKTsKICB9KTsKPC9zY3JpcHQ+CjwvYm9keT4KPC9odG1sPgo=`;

function decodeBase64Utf8(b64) {
  const compact = b64.replace(/\s+/g, "");
  const binary = atob(compact);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function renderDashboardHtml() {
  return decodeBase64Utf8(DASHBOARD_HTML_B64);
}
