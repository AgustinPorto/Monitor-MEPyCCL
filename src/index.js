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
      "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self' https://dolarito.ar https://argentinadatos.com https://api.argentinadatos.com; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

const DASHBOARD_HTML_B64 = `PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVzIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAiPgo8dGl0bGU+UmFkYXIgTUVQL0NDTCDCtyBNZXJjYWRvIEFSRzwvdGl0bGU+CjxsaW5rIHJlbD0icHJlY29ubmVjdCIgaHJlZj0iaHR0cHM6Ly9mb250cy5nb29nbGVhcGlzLmNvbSI+CjxsaW5rIGhyZWY9Imh0dHBzOi8vZm9udHMuZ29vZ2xlYXBpcy5jb20vY3NzMj9mYW1pbHk9U3BhY2UrTW9ubzp3Z2h0QDQwMDs3MDAmZmFtaWx5PVN5bmU6d2dodEA0MDA7NjAwOzcwMDs4MDAmZGlzcGxheT1zd2FwIiByZWw9InN0eWxlc2hlZXQiPgo8c3R5bGU+Ci8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBUT0tFTlMK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCjpyb290IHsKICAtLWJnOiAgICAgICAjMDgwYjBlOwogIC0tc3VyZjogICAgICMwZjEzMTg7CiAgLS1zdXJmMjogICAgIzE2MWIyMjsKICAtLXN1cmYzOiAgICAjMWMyMzMwOwogIC0tYm9yZGVyOiAgICMxZTI1MzA7CiAgLS1ib3JkZXJCOiAgIzJhMzQ0NDsKCiAgLS1ncmVlbjogICAgIzAwZTY3NjsKICAtLWdyZWVuLWQ6ICByZ2JhKDAsMjMwLDExOCwuMDkpOwogIC0tZ3JlZW4tZzogIHJnYmEoMCwyMzAsMTE4LC4yMik7CiAgLS1yZWQ6ICAgICAgI2ZmNDc1NzsKICAtLXJlZC1kOiAgICByZ2JhKDI1NSw3MSw4NywuMDkpOwogIC0teWVsbG93OiAgICNmZmMgYzAwOwogIC0teWVsbG93OiAgICNmZmNjMDA7CiAgLS15ZWxsb3ctZDogcmdiYSgyNTUsMjA0LDAsLjA5KTsKCiAgLS1tZXA6ICAgICAgIzI5YjZmNjsKICAtLWNjbDogICAgICAjYjM5ZGRiOwogIC0tdGV4dDogICAgICNkZGU0ZWU7CiAgLS1tdXRlZDogICAgIzU1NjA3MDsKICAtLW11dGVkMjogICAjN2E4ZmE4OwoKICAtLW1vbm86ICdTcGFjZSBNb25vJywgbW9ub3NwYWNlOwogIC0tc2FuczogJ1N5bmUnLCBzYW5zLXNlcmlmOwoKICAtLWRyYXdlci13OiA0MDBweDsKICAtLWhlYWRlci1oOiA1NHB4Owp9CgoqLCAqOjpiZWZvcmUsICo6OmFmdGVyIHsgYm94LXNpemluZzogYm9yZGVyLWJveDsgbWFyZ2luOiAwOyBwYWRkaW5nOiAwOyB9CgpodG1sIHsgc2Nyb2xsLWJlaGF2aW9yOiBzbW9vdGg7IH0KCmJvZHkgewogIGJhY2tncm91bmQ6IHZhcigtLWJnKTsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgZm9udC1mYW1pbHk6IHZhcigtLW1vbm8pOwogIG1pbi1oZWlnaHQ6IDEwMHZoOwogIG92ZXJmbG93LXg6IGhpZGRlbjsKfQoKYm9keTo6YmVmb3JlIHsKICBjb250ZW50OiAnJzsKICBwb3NpdGlvbjogZml4ZWQ7IGluc2V0OiAwOwogIGJhY2tncm91bmQtaW1hZ2U6CiAgICBsaW5lYXItZ3JhZGllbnQocmdiYSg0MSwxODIsMjQ2LC4wMjUpIDFweCwgdHJhbnNwYXJlbnQgMXB4KSwKICAgIGxpbmVhci1ncmFkaWVudCg5MGRlZywgcmdiYSg0MSwxODIsMjQ2LC4wMjUpIDFweCwgdHJhbnNwYXJlbnQgMXB4KTsKICBiYWNrZ3JvdW5kLXNpemU6IDQ0cHggNDRweDsKICBwb2ludGVyLWV2ZW50czogbm9uZTsgei1pbmRleDogMDsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIExBWU9VVCBTSEVMTArilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLmFwcCB7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBtaW4taGVpZ2h0OiAxMDB2aDsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIEhFQURFUgrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KaGVhZGVyIHsKICBwb3NpdGlvbjogc3RpY2t5OyB0b3A6IDA7IHotaW5kZXg6IDIwMDsKICBoZWlnaHQ6IHZhcigtLWhlYWRlci1oKTsKICBiYWNrZ3JvdW5kOiByZ2JhKDgsMTEsMTQsLjkzKTsKICBiYWNrZHJvcC1maWx0ZXI6IGJsdXIoMThweCk7CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgcGFkZGluZzogMCAyMnB4OwogIGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsKfQoKLmxvZ28gewogIGZvbnQtZmFtaWx5OiB2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6IDgwMDsgZm9udC1zaXplOiAxNXB4OwogIGxldHRlci1zcGFjaW5nOiAuMDVlbTsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA5cHg7Cn0KCi5saXZlLWRvdCB7CiAgd2lkdGg6IDdweDsgaGVpZ2h0OiA3cHg7IGJvcmRlci1yYWRpdXM6IDUwJTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1ncmVlbik7CiAgYm94LXNoYWRvdzogMCAwIDhweCB2YXIoLS1ncmVlbik7CiAgYW5pbWF0aW9uOiBibGluayAyLjJzIGVhc2UtaW4tb3V0IGluZmluaXRlOwp9CkBrZXlmcmFtZXMgYmxpbmsgewogIDAlLDEwMCV7b3BhY2l0eToxO2JveC1zaGFkb3c6MCAwIDhweCB2YXIoLS1ncmVlbik7fQogIDUwJXtvcGFjaXR5Oi4zNTtib3gtc2hhZG93OjAgMCAzcHggdmFyKC0tZ3JlZW4pO30KfQoKLmhlYWRlci1yaWdodCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMTJweDsgfQoKLmZyZXNoLWJhZGdlIHsKICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDVweDsKICBmb250LXNpemU6IDExcHg7IGNvbG9yOiB2YXIoLS1tdXRlZDIpOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYyKTsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOiAyMHB4OyBwYWRkaW5nOiAzcHggMTFweDsKfQouZnJlc2gtZG90IHsgd2lkdGg6NXB4O2hlaWdodDo1cHg7Ym9yZGVyLXJhZGl1czo1MCU7YmFja2dyb3VuZDp2YXIoLS1ncmVlbik7YW5pbWF0aW9uOmJsaW5rIDIuMnMgZWFzZS1pbi1vdXQgaW5maW5pdGU7IH0KLmZyZXNoLWJhZGdlLmZldGNoaW5nIHsgYW5pbWF0aW9uOiBiYWRnZVB1bHNlIDEuMnMgZWFzZS1pbi1vdXQgaW5maW5pdGU7IH0KLmZyZXNoLWJhZGdlLmVycm9yIHsgY29sb3I6I2ZmZDBkMDsgYm9yZGVyLWNvbG9yOnJnYmEoMjU1LDgyLDgyLC40NSk7IGJhY2tncm91bmQ6cmdiYSgyNTUsODIsODIsLjEyKTsgY3Vyc29yOnBvaW50ZXI7IH0KQGtleWZyYW1lcyBiYWRnZVB1bHNlIHsKICAwJSwxMDAlIHsgb3BhY2l0eToxOyB9CiAgNTAlIHsgb3BhY2l0eTouNjU7IH0KfQoKLnRhZy1tZXJjYWRvIHsKICBmb250LWZhbWlseTogdmFyKC0tc2Fucyk7IGZvbnQtc2l6ZToxMHB4OyBmb250LXdlaWdodDo3MDA7CiAgbGV0dGVyLXNwYWNpbmc6LjA4ZW07IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsKICBiYWNrZ3JvdW5kOnZhcigtLWdyZWVuKTsgY29sb3I6IzAwMDsKICBwYWRkaW5nOjNweCA5cHg7IGJvcmRlci1yYWRpdXM6NHB4Owp9Ci50YWctbWVyY2Fkby5jbG9zZWQgeyBiYWNrZ3JvdW5kOnZhcigtLW11dGVkKTsgY29sb3I6IzBhMGMwZjsgfQoKLmJ0biB7CiAgZm9udC1mYW1pbHk6IHZhcigtLXNhbnMpOyBmb250LXNpemU6MTFweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4wN2VtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7CiAgYm9yZGVyLXJhZGl1czo2cHg7IHBhZGRpbmc6NnB4IDE0cHg7IGN1cnNvcjpwb2ludGVyOwogIGJvcmRlcjpub25lOyB0cmFuc2l0aW9uOiBhbGwgLjE4czsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo2cHg7Cn0KLmJ0bi1hbGVydCB7IGJhY2tncm91bmQ6dmFyKC0tZ3JlZW4pOyBjb2xvcjojMDAwOyB9Ci5idG4tYWxlcnQ6aG92ZXIgeyBiYWNrZ3JvdW5kOiMwMGZmODg7IHRyYW5zZm9ybTp0cmFuc2xhdGVZKC0xcHgpOyB9CgouYnRuLXRhc2FzIHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMik7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyQik7CiAgY29sb3I6IHZhcigtLXRleHQpOwp9Ci5idG4tdGFzYXM6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMyk7IGJvcmRlci1jb2xvcjogdmFyKC0tbXV0ZWQyKTsgfQouYnRuLXRhc2FzLmFjdGl2ZSB7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZjMpOwogIGJvcmRlci1jb2xvcjogdmFyKC0teWVsbG93KTsKICBjb2xvcjogdmFyKC0teWVsbG93KTsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIE1BSU4gKyBEUkFXRVIgTEFZT1VUCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwouYm9keS13cmFwIHsKICBmbGV4OiAxOwogIGRpc3BsYXk6IGZsZXg7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIHotaW5kZXg6IDE7CiAgdHJhbnNpdGlvbjogbm9uZTsKfQoKLm1haW4tY29udGVudCB7CiAgZmxleDogMTsKICBtYXgtd2lkdGg6IDEwMCU7CiAgcGFkZGluZzogMjJweCAyMnB4IDYwcHg7CiAgdHJhbnNpdGlvbjogbWFyZ2luLXJpZ2h0IC4zNXMgY3ViaWMtYmV6aWVyKC40LDAsLjIsMSk7Cn0KCi5ib2R5LXdyYXAuZHJhd2VyLW9wZW4gLm1haW4tY29udGVudCB7CiAgbWFyZ2luLXJpZ2h0OiB2YXIoLS1kcmF3ZXItdyk7Cn0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBEUkFXRVIK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5kcmF3ZXIgewogIHBvc2l0aW9uOiBmaXhlZDsKICB0b3A6IHZhcigtLWhlYWRlci1oKTsKICByaWdodDogMDsKICB3aWR0aDogdmFyKC0tZHJhd2VyLXcpOwogIGhlaWdodDogY2FsYygxMDB2aCAtIHZhcigtLWhlYWRlci1oKSk7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZik7CiAgYm9yZGVyLWxlZnQ6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIHRyYW5zZm9ybTogdHJhbnNsYXRlWCgxMDAlKTsKICB0cmFuc2l0aW9uOiB0cmFuc2Zvcm0gLjM1cyBjdWJpYy1iZXppZXIoLjQsMCwuMiwxKTsKICBvdmVyZmxvdy15OiBhdXRvOwogIHotaW5kZXg6IDE1MDsKICBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwp9CgouZHJhd2VyLm9wZW4geyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVgoMCk7IH0KCi5kcmF3ZXItaGVhZGVyIHsKICBwb3NpdGlvbjogc3RpY2t5OyB0b3A6IDA7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZik7CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgcGFkZGluZzogMTZweCAyMHB4OwogIGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsKICB6LWluZGV4OiAxMDsKfQoKLmRyYXdlci10aXRsZSB7CiAgZm9udC1mYW1pbHk6IHZhcigtLXNhbnMpOyBmb250LXdlaWdodDogODAwOyBmb250LXNpemU6IDEzcHg7CiAgbGV0dGVyLXNwYWNpbmc6LjA0ZW07IGNvbG9yOiB2YXIoLS10ZXh0KTsKICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo4cHg7Cn0KCi5kcmF3ZXItc291cmNlIHsKICBmb250LXNpemU6MTBweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBmb250LWZhbWlseTp2YXIoLS1tb25vKTsKfQoKLmJ0bi1jbG9zZSB7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmMik7IGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBjb2xvcjp2YXIoLS1tdXRlZDIpOyBib3JkZXItcmFkaXVzOjZweDsgcGFkZGluZzo1cHggMTBweDsKICBjdXJzb3I6cG9pbnRlcjsgZm9udC1zaXplOjEzcHg7IHRyYW5zaXRpb246IGFsbCAuMTVzOwp9Ci5idG4tY2xvc2U6aG92ZXIgeyBjb2xvcjp2YXIoLS10ZXh0KTsgYm9yZGVyLWNvbG9yOnZhcigtLW11dGVkMik7IH0KCi5kcmF3ZXItYm9keSB7IHBhZGRpbmc6IDE2cHggMjBweDsgZGlzcGxheTogZmxleDsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgZ2FwOiAyMnB4OyB9CgouY29udGV4dC1ib3ggewogIGJhY2tncm91bmQ6IHJnYmEoMjU1LDIwNCwwLC4wNik7CiAgYm9yZGVyOiAxcHggc29saWQgcmdiYSgyNTUsMjA0LDAsLjIpOwogIGJvcmRlci1yYWRpdXM6IDlweDsKICBwYWRkaW5nOiAxM3B4IDE1cHg7CiAgZm9udC1zaXplOiAxMXB4OwogIGxpbmUtaGVpZ2h0OjEuNjU7CiAgY29sb3I6dmFyKC0tbXV0ZWQyKTsKfQouY29udGV4dC1ib3ggc3Ryb25nIHsgY29sb3I6dmFyKC0teWVsbG93KTsgfQoKLmZjaS1oZWFkZXIgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGJhc2VsaW5lOwogIGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsKICBnYXA6IDEwcHg7Cn0KLmZjaS10aXRsZSB7CiAgZm9udC1mYW1pbHk6IHZhcigtLXNhbnMpOwogIGZvbnQtc2l6ZTogMTJweDsKICBmb250LXdlaWdodDogNzAwOwogIGxldHRlci1zcGFjaW5nOiAuMDVlbTsKICB0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlOwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKfQouZmNpLW1ldGEgewogIGZvbnQtc2l6ZTogMTBweDsKICBjb2xvcjogdmFyKC0tbXV0ZWQpOwp9Ci5mY2ktdGFibGUtd3JhcCB7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOiAxMHB4OwogIG92ZXJmbG93OiBhdXRvOwp9Ci5mY2ktdGFibGUgewogIHdpZHRoOiAxMDAlOwogIGJvcmRlci1jb2xsYXBzZTogY29sbGFwc2U7Cn0KLmZjaS10YWJsZSB0aGVhZCB0aCB7CiAgcG9zaXRpb246IHN0aWNreTsKICB0b3A6IDA7CiAgei1pbmRleDogNTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMik7CiAgY29sb3I6IHZhcigtLW11dGVkMik7CiAgZm9udC1zaXplOiAxMHB4OwogIGxldHRlci1zcGFjaW5nOiAuMDhlbTsKICB0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlOwogIHRleHQtYWxpZ246IGxlZnQ7CiAgcGFkZGluZzogOXB4IDEwcHg7CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Cn0KLmZjaS10YWJsZSB0aGVhZCB0aDpob3ZlciB7CiAgei1pbmRleDogODA7Cn0KLmZjaS10YWJsZSB0Ym9keSB0ciB7CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Cn0KLmZjaS10YWJsZSB0Ym9keSB0cjpsYXN0LWNoaWxkIHsKICBib3JkZXItYm90dG9tOiBub25lOwp9Ci5mY2ktdGFibGUgdGQgewogIGZvbnQtc2l6ZTogMTFweDsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgcGFkZGluZzogOXB4IDEwcHg7CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKfQouZmNpLWVtcHR5IHsKICBmb250LXNpemU6IDExcHg7CiAgY29sb3I6IHZhcigtLW11dGVkMik7CiAgcGFkZGluZzogMTJweDsKICBib3JkZXI6IDFweCBkYXNoZWQgdmFyKC0tYm9yZGVyQik7CiAgYm9yZGVyLXJhZGl1czogMTBweDsKfQouZmNpLWNvbnRyb2xzIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuOwogIGdhcDogMTBweDsKfQouZmNpLXNlYXJjaCB7CiAgd2lkdGg6IDEwMCU7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZjIpOwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlckIpOwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKICBib3JkZXItcmFkaXVzOiA4cHg7CiAgcGFkZGluZzogOHB4IDEwcHg7CiAgZm9udC1zaXplOiAxMXB4OwogIG91dGxpbmU6IG5vbmU7Cn0KLmZjaS1zZWFyY2g6Zm9jdXMgewogIGJvcmRlci1jb2xvcjogdmFyKC0tbXV0ZWQyKTsKfQouZmNpLXBhZ2luYXRpb24gewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDhweDsKICBmbGV4LXNocmluazogMDsKfQouZmNpLXBhZ2UtYnRuIHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMik7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyQik7CiAgY29sb3I6IHZhcigtLXRleHQpOwogIGJvcmRlci1yYWRpdXM6IDZweDsKICBmb250LXNpemU6IDEwcHg7CiAgZm9udC13ZWlnaHQ6IDcwMDsKICB0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlOwogIGxldHRlci1zcGFjaW5nOiAuMDZlbTsKICBwYWRkaW5nOiA1cHggOHB4OwogIGN1cnNvcjogcG9pbnRlcjsKfQouZmNpLXBhZ2UtYnRuOmRpc2FibGVkIHsKICBvcGFjaXR5OiAuNDsKICBjdXJzb3I6IGRlZmF1bHQ7Cn0KLmZjaS1wYWdlLWluZm8gewogIGZvbnQtc2l6ZTogMTBweDsKICBjb2xvcjogdmFyKC0tbXV0ZWQyKTsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIFNUQVRVUyBCQU5ORVIK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5zdGF0dXMtYmFubmVyIHsKICBib3JkZXItcmFkaXVzOjExcHg7IHBhZGRpbmc6MThweCAyNHB4OyBtYXJnaW4tYm90dG9tOjIwcHg7CiAgYm9yZGVyOjFweCBzb2xpZDsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47CiAgYW5pbWF0aW9uOmZhZGVJbiAuNHMgZWFzZTsKICBvdmVyZmxvdzpoaWRkZW47IHBvc2l0aW9uOnJlbGF0aXZlOwp9Ci5zdGF0dXMtYmFubmVyLnNpbWlsYXIgewogIGJhY2tncm91bmQ6dmFyKC0tZ3JlZW4tZCk7IGJvcmRlci1jb2xvcjpyZ2JhKDAsMjMwLDExOCwuMjgpOwp9Ci5zdGF0dXMtYmFubmVyLnNpbWlsYXI6OmFmdGVyIHsKICBjb250ZW50OicnOyBwb3NpdGlvbjphYnNvbHV0ZTsgcmlnaHQ6LTUwcHg7IHRvcDo1MCU7CiAgdHJhbnNmb3JtOnRyYW5zbGF0ZVkoLTUwJSk7IHdpZHRoOjIwMHB4OyBoZWlnaHQ6MjAwcHg7CiAgYm9yZGVyLXJhZGl1czo1MCU7CiAgYmFja2dyb3VuZDpyYWRpYWwtZ3JhZGllbnQoY2lyY2xlLHZhcigtLWdyZWVuLWcpIDAlLHRyYW5zcGFyZW50IDcwJSk7CiAgcG9pbnRlci1ldmVudHM6bm9uZTsKfQouc3RhdHVzLWJhbm5lci5uby1zaW1pbGFyIHsKICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSw4Miw4MiwuMDgpOwogIGJvcmRlci1jb2xvcjogcmdiYSgyNTUsODIsODIsLjM1KTsKfQouc3RhdHVzLWJhbm5lci5uby1zaW1pbGFyOjphZnRlciB7CiAgY29udGVudDonJzsKICBwb3NpdGlvbjphYnNvbHV0ZTsKICByaWdodDotNTBweDsKICB0b3A6NTAlOwogIHRyYW5zZm9ybTp0cmFuc2xhdGVZKC01MCUpOwogIHdpZHRoOjIwMHB4OwogIGhlaWdodDoyMDBweDsKICBib3JkZXItcmFkaXVzOjUwJTsKICBiYWNrZ3JvdW5kOnJhZGlhbC1ncmFkaWVudChjaXJjbGUscmdiYSgyNTUsODIsODIsLjE4KSAwJSx0cmFuc3BhcmVudCA3MCUpOwogIHBvaW50ZXItZXZlbnRzOm5vbmU7Cn0KCi5zLWxlZnQge30KLnMtdGl0bGUgewogIGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXdlaWdodDo4MDA7IGZvbnQtc2l6ZToyNnB4OwogIGxldHRlci1zcGFjaW5nOi0uMDJlbTsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDoxMnB4Owp9Ci5zLWJhZGdlIHsKICBmb250LXNpemU6MTBweDsgZm9udC13ZWlnaHQ6NzAwOyBsZXR0ZXItc3BhY2luZzouMWVtOwogIHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsgcGFkZGluZzoycHggOXB4OyBib3JkZXItcmFkaXVzOjRweDsKICBiYWNrZ3JvdW5kOnZhcigtLWdyZWVuKTsgY29sb3I6IzAwMDsgYWxpZ24tc2VsZjpjZW50ZXI7Cn0KLnMtYmFkZ2Uubm9zaW0geyBiYWNrZ3JvdW5kOiB2YXIoLS1yZWQpOyBjb2xvcjogI2ZmZjsgfQoucy1zdWIgeyBmb250LXNpemU6MTFweDsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgbWFyZ2luLXRvcDo0cHg7IH0KCi5lcnJvci1iYW5uZXIgewogIGRpc3BsYXk6bm9uZTsKICBtYXJnaW46IDAgMCAxNHB4IDA7CiAgcGFkZGluZzogMTBweCAxMnB4OwogIGJvcmRlci1yYWRpdXM6IDhweDsKICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDI1NSw4Miw4MiwuNDUpOwogIGJhY2tncm91bmQ6IHJnYmEoMjU1LDgyLDgyLC4xMik7CiAgY29sb3I6ICNmZmQwZDA7CiAgZm9udC1zaXplOiAxMXB4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuOwogIGdhcDogMTBweDsKfQouZXJyb3ItYmFubmVyLnNob3cgeyBkaXNwbGF5OmZsZXg7IH0KLmVycm9yLWJhbm5lciBidXR0b24gewogIGJvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsODIsODIsLjUpOwogIGJhY2tncm91bmQ6IHJnYmEoMjU1LDgyLDgyLC4xNSk7CiAgY29sb3I6I2ZmZGVkZTsKICBib3JkZXItcmFkaXVzOjZweDsKICBwYWRkaW5nOjRweCAxMHB4OwogIGZvbnQtc2l6ZToxMHB4OwogIGZvbnQtd2VpZ2h0OjcwMDsKICB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7CiAgbGV0dGVyLXNwYWNpbmc6LjA2ZW07CiAgY3Vyc29yOnBvaW50ZXI7Cn0KCi5za2VsZXRvbiB7CiAgYmFja2dyb3VuZDogbGluZWFyLWdyYWRpZW50KDkwZGVnLCAjMWMyMzMwIDI1JSwgIzJhMzQ0NCA1MCUsICMxYzIzMzAgNzUlKTsKICBiYWNrZ3JvdW5kLXNpemU6IDIwMCUgMTAwJTsKICBhbmltYXRpb246IHNoaW1tZXIgMS40cyBpbmZpbml0ZTsKICBib3JkZXItcmFkaXVzOiA0cHg7CiAgY29sb3I6IHRyYW5zcGFyZW50OwogIHVzZXItc2VsZWN0OiBub25lOwp9CkBrZXlmcmFtZXMgc2hpbW1lciB7CiAgMCUgICB7IGJhY2tncm91bmQtcG9zaXRpb246IDIwMCUgMDsgfQogIDEwMCUgeyBiYWNrZ3JvdW5kLXBvc2l0aW9uOiAtMjAwJSAwOyB9Cn0KCi52YWx1ZS1jaGFuZ2VkIHsKICBhbmltYXRpb246IGZsYXNoVmFsdWUgNjAwbXMgZWFzZTsKfQpAa2V5ZnJhbWVzIGZsYXNoVmFsdWUgewogIDAlICAgeyBjb2xvcjogI2ZmY2MwMDsgfQogIDEwMCUgeyBjb2xvcjogaW5oZXJpdDsgfQp9Cgoucy1yaWdodCB7IHRleHQtYWxpZ246cmlnaHQ7IGZvbnQtc2l6ZToxMXB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7IGxpbmUtaGVpZ2h0OjEuOTsgfQoucy1yaWdodCBzdHJvbmcgeyBjb2xvcjp2YXIoLS1tdXRlZDIpOyB9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgSEVSTyBDQVJEUwrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLmhlcm8tZ3JpZCB7CiAgZGlzcGxheTpncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmciAxZnI7CiAgZ2FwOjE0cHg7IG1hcmdpbi1ib3R0b206MjBweDsKfQoKLmhjYXJkIHsKICBiYWNrZ3JvdW5kOnZhcigtLXN1cmYpOyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czoxMXB4OyBwYWRkaW5nOjIwcHggMjJweDsKICBwb3NpdGlvbjpyZWxhdGl2ZTsgb3ZlcmZsb3c6aGlkZGVuOwogIHRyYW5zaXRpb246Ym9yZGVyLWNvbG9yIC4xOHM7CiAgYW5pbWF0aW9uOiBmYWRlVXAgLjVzIGVhc2UgYm90aDsKfQouaGNhcmQ6bnRoLWNoaWxkKDEpe2FuaW1hdGlvbi1kZWxheTouMDhzO30KLmhjYXJkOm50aC1jaGlsZCgyKXthbmltYXRpb24tZGVsYXk6LjE2czt9Ci5oY2FyZDpudGgtY2hpbGQoMyl7YW5pbWF0aW9uLWRlbGF5Oi4yNHM7fQouaGNhcmQ6aG92ZXIgeyBib3JkZXItY29sb3I6dmFyKC0tYm9yZGVyQik7IH0KCi5oY2FyZCAuYmFyIHsgcG9zaXRpb246YWJzb2x1dGU7IHRvcDowO2xlZnQ6MDtyaWdodDowOyBoZWlnaHQ6MnB4OyB9Ci5oY2FyZC5tZXAgLmJhciB7IGJhY2tncm91bmQ6dmFyKC0tbWVwKTsgfQouaGNhcmQuY2NsIC5iYXIgeyBiYWNrZ3JvdW5kOnZhcigtLWNjbCk7IH0KLmhjYXJkLmdhcCAuYmFyIHsgYmFja2dyb3VuZDp2YXIoLS15ZWxsb3cpOyB9CgouaGNhcmQtbGFiZWwgewogIGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXNpemU6MTBweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4xMmVtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7IGNvbG9yOnZhcigtLW11dGVkKTsKICBtYXJnaW4tYm90dG9tOjlweDsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo1cHg7Cn0KLmhjYXJkLWxhYmVsIC5kb3QgeyB3aWR0aDo1cHg7aGVpZ2h0OjVweDtib3JkZXItcmFkaXVzOjUwJTsgfQoubWVwIC5kb3R7YmFja2dyb3VuZDp2YXIoLS1tZXApO30KLmNjbCAuZG90e2JhY2tncm91bmQ6dmFyKC0tY2NsKTt9Ci5nYXAgLmRvdHtiYWNrZ3JvdW5kOnZhcigtLXllbGxvdyk7fQoKLmhjYXJkLXZhbCB7CiAgZm9udC1zaXplOjM0cHg7IGZvbnQtd2VpZ2h0OjcwMDsgbGV0dGVyLXNwYWNpbmc6LS4wMmVtOyBsaW5lLWhlaWdodDoxOwp9Ci5tZXAgLmhjYXJkLXZhbHtjb2xvcjp2YXIoLS1tZXApO30KLmNjbCAuaGNhcmQtdmFse2NvbG9yOnZhcigtLWNjbCk7fQoKLmhjYXJkLXBjdCB7IGZvbnQtc2l6ZToyMHB4OyBjb2xvcjp2YXIoLS15ZWxsb3cpOyBmb250LXdlaWdodDo3MDA7IG1hcmdpbi10b3A6M3B4OyB9Ci5oY2FyZC1zdWIgeyBmb250LXNpemU6MTBweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBtYXJnaW4tdG9wOjdweDsgfQoKLyogdG9vbHRpcCAqLwoudGlwIHsgcG9zaXRpb246cmVsYXRpdmU7IGN1cnNvcjpoZWxwOyB9Ci50aXA6OmFmdGVyIHsKICBjb250ZW50OmF0dHIoZGF0YS10KTsKICBwb3NpdGlvbjphYnNvbHV0ZTsgYm90dG9tOmNhbGMoMTAwJSArIDdweCk7IGxlZnQ6NTAlOwogIHRyYW5zZm9ybTp0cmFuc2xhdGVYKC01MCUpOwogIGJhY2tncm91bmQ6IzFhMjIzMjsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXJCKTsKICBjb2xvcjp2YXIoLS10ZXh0KTsgZm9udC1zaXplOjEwcHg7IHBhZGRpbmc6NXB4IDlweDsKICBib3JkZXItcmFkaXVzOjZweDsgd2hpdGUtc3BhY2U6bm93cmFwOwogIG9wYWNpdHk6MDsgcG9pbnRlci1ldmVudHM6bm9uZTsgdHJhbnNpdGlvbjpvcGFjaXR5IC4xOHM7IHotaW5kZXg6OTk7Cn0KLnRpcDpob3Zlcjo6YWZ0ZXJ7b3BhY2l0eToxO30KLnRpcC50aXAtZG93bjo6YWZ0ZXIgewogIHRvcDogY2FsYygxMDAlICsgN3B4KTsKICBib3R0b206IGF1dG87CiAgbGVmdDogMDsKICB0cmFuc2Zvcm06IG5vbmU7CiAgd2hpdGUtc3BhY2U6IG5vcm1hbDsKICB3aWR0aDogMjIwcHg7CiAgei1pbmRleDogMjAwOwp9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgQ0hBUlQK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5jaGFydC1jYXJkIHsKICBiYWNrZ3JvdW5kOnZhcigtLXN1cmYpOyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czoxMXB4OyBwYWRkaW5nOjIycHg7IG1hcmdpbi1ib3R0b206MjBweDsKICBhbmltYXRpb246ZmFkZVVwIC41cyAuMzJzIGVhc2UgYm90aDsKfQouY2hhcnQtdG9wIHsKICBkaXNwbGF5OmZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsganVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47CiAgbWFyZ2luLWJvdHRvbToxNnB4Owp9Ci5jaGFydC10dGwgeyBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6NzAwOyBmb250LXNpemU6MTNweDsgfQoKLnBpbGxzIHsgZGlzcGxheTpmbGV4OyBnYXA6NXB4OyB9Ci5waWxsIHsKICBmb250LXNpemU6MTBweDsgcGFkZGluZzozcHggMTFweDsgYm9yZGVyLXJhZGl1czoyMHB4OwogIGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyQik7IGNvbG9yOnZhcigtLW11dGVkMik7CiAgYmFja2dyb3VuZDp0cmFuc3BhcmVudDsgY3Vyc29yOnBvaW50ZXI7IGZvbnQtZmFtaWx5OnZhcigtLW1vbm8pOwogIHRyYW5zaXRpb246YWxsIC4xM3M7Cn0KLnBpbGwub24geyBiYWNrZ3JvdW5kOnZhcigtLW1lcCk7IGJvcmRlci1jb2xvcjp2YXIoLS1tZXApOyBjb2xvcjojMDAwOyBmb250LXdlaWdodDo3MDA7IH0KCi5sZWdlbmRzIHsgZGlzcGxheTpmbGV4OyBnYXA6MThweDsgbWFyZ2luLWJvdHRvbToxNHB4OyBmb250LXNpemU6MTBweDsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgfQoubGVnIHsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo1cHg7IH0KLmxlZy1saW5lIHsgd2lkdGg6MThweDsgaGVpZ2h0OjJweDsgYm9yZGVyLXJhZGl1czoycHg7IH0KCnN2Zy5jaGFydCB7IHdpZHRoOjEwMCU7IGhlaWdodDoxNzBweDsgb3ZlcmZsb3c6dmlzaWJsZTsgfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIE1FVFJJQ1MK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5tZXRyaWNzLWdyaWQgewogIGRpc3BsYXk6Z3JpZDsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCg0LDFmcik7CiAgZ2FwOjEycHg7IG1hcmdpbi1ib3R0b206MjBweDsKfQoubWNhcmQgewogIGJhY2tncm91bmQ6dmFyKC0tc3VyZjIpOyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czo5cHg7IHBhZGRpbmc6MTRweCAxNnB4OwogIGFuaW1hdGlvbjpmYWRlVXAgLjVzIGVhc2UgYm90aDsKfQoubWNhcmQ6bnRoLWNoaWxkKDEpe2FuaW1hdGlvbi1kZWxheTouMzhzO30KLm1jYXJkOm50aC1jaGlsZCgyKXthbmltYXRpb24tZGVsYXk6LjQzczt9Ci5tY2FyZDpudGgtY2hpbGQoMyl7YW5pbWF0aW9uLWRlbGF5Oi40OHM7fQoubWNhcmQ6bnRoLWNoaWxkKDQpe2FuaW1hdGlvbi1kZWxheTouNTNzO30KLm1jYXJkLWxhYmVsIHsKICBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC1zaXplOjlweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4xZW07IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsgY29sb3I6dmFyKC0tbXV0ZWQpOyBtYXJnaW4tYm90dG9tOjdweDsKfQoubWNhcmQtdmFsIHsgZm9udC1zaXplOjIwcHg7IGZvbnQtd2VpZ2h0OjcwMDsgfQoubWNhcmQtc3ViIHsgZm9udC1zaXplOjlweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBtYXJnaW4tdG9wOjNweDsgfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIFRBQkxFCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwoudGFibGUtY2FyZCB7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmKTsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yYWRpdXM6MTFweDsgb3ZlcmZsb3c6aGlkZGVuOwogIGFuaW1hdGlvbjpmYWRlVXAgLjVzIC41NnMgZWFzZSBib3RoOwp9Ci50YWJsZS10b3AgewogIHBhZGRpbmc6MTRweCAyMnB4OyBib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjsKfQoudGFibGUtdHRsIHsgZm9udC1mYW1pbHk6dmFyKC0tc2Fucyk7IGZvbnQtd2VpZ2h0OjcwMDsgZm9udC1zaXplOjEzcHg7IH0KLnRhYmxlLXJpZ2h0IHsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDoxMHB4OyB9Ci50YWJsZS1jYXAgeyBmb250LXNpemU6MTBweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyB9Ci5idG4tZG93bmxvYWQgewogIGRpc3BsYXk6aW5saW5lLWZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsgZ2FwOjZweDsKICBoZWlnaHQ6MjZweDsgcGFkZGluZzowIDEwcHg7IGJvcmRlci1yYWRpdXM6N3B4OwogIGJvcmRlcjoxcHggc29saWQgIzJmNGY2ODsgYmFja2dyb3VuZDpyZ2JhKDQxLDE4MiwyNDYsMC4wNik7CiAgY29sb3I6IzhmZDhmZjsgY3Vyc29yOnBvaW50ZXI7IGZvbnQtZmFtaWx5OnZhcigtLW1vbm8pOyBmb250LXNpemU6MTBweDsKICBsZXR0ZXItc3BhY2luZzouMDJlbTsKICB0cmFuc2l0aW9uOmJvcmRlci1jb2xvciAuMTVzIGVhc2UsIGJhY2tncm91bmQgLjE1cyBlYXNlLCBjb2xvciAuMTVzIGVhc2UsIGJveC1zaGFkb3cgLjE1cyBlYXNlOwp9Ci5idG4tZG93bmxvYWQgc3ZnIHsKICB3aWR0aDoxMnB4OyBoZWlnaHQ6MTJweDsgc3Ryb2tlOmN1cnJlbnRDb2xvcjsgZmlsbDpub25lOyBzdHJva2Utd2lkdGg6MS44Owp9Ci5idG4tZG93bmxvYWQ6aG92ZXIgewogIGJvcmRlci1jb2xvcjojNGZjM2Y3OyBiYWNrZ3JvdW5kOnJnYmEoNDEsMTgyLDI0NiwwLjE2KTsKICBjb2xvcjojYzZlY2ZmOyBib3gtc2hhZG93OjAgMCAwIDFweCByZ2JhKDc5LDE5NSwyNDcsLjE4KSBpbnNldDsKfQoKLmhpc3RvcnktdGFibGUtd3JhcCB7IG92ZXJmbG93LXg6YXV0bzsgfQouaGlzdG9yeS10YWJsZS13cmFwIHRhYmxlIHsKICBtaW4td2lkdGg6IDg2MHB4Owp9CnRhYmxlIHsgd2lkdGg6MTAwJTsgYm9yZGVyLWNvbGxhcHNlOmNvbGxhcHNlOyB0YWJsZS1sYXlvdXQ6Zml4ZWQ7IH0KdGhlYWQgdGggewogIGZvbnQtc2l6ZTo5cHg7IGxldHRlci1zcGFjaW5nOi4xZW07IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsKICBjb2xvcjp2YXIoLS1tdXRlZCk7IHBhZGRpbmc6OXB4IDIycHg7IHRleHQtYWxpZ246bGVmdDsKICBiYWNrZ3JvdW5kOnZhcigtLXN1cmYyKTsgZm9udC1mYW1pbHk6dmFyKC0tc2Fucyk7IGZvbnQtd2VpZ2h0OjYwMDsKICBwb3NpdGlvbjpyZWxhdGl2ZTsKfQp0Ym9keSB0ciB7IGJvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7IHRyYW5zaXRpb246YmFja2dyb3VuZCAuMTJzOyB9CnRib2R5IHRyOmhvdmVyIHsgYmFja2dyb3VuZDpyZ2JhKDQxLDE4MiwyNDYsLjA0KTsgfQp0Ym9keSB0cjpsYXN0LWNoaWxkIHsgYm9yZGVyLWJvdHRvbTpub25lOyB9CnRib2R5IHRkIHsKICBwYWRkaW5nOjExcHggMjJweDsgZm9udC1zaXplOjEycHg7CiAgb3ZlcmZsb3c6aGlkZGVuOyB0ZXh0LW92ZXJmbG93OmVsbGlwc2lzOyB3aGl0ZS1zcGFjZTpub3dyYXA7Cn0KdGQuZGltIHsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgZm9udC1zaXplOjExcHg7IH0KdGQuZGltIC50cy1kYXkgeyBmb250LXNpemU6OXB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7IGxpbmUtaGVpZ2h0OjEuMTsgfQp0ZC5kaW0gLnRzLWhvdXIgeyBmb250LXNpemU6MTFweDsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgbGluZS1oZWlnaHQ6MS4yOyBtYXJnaW4tdG9wOjJweDsgfQouY29sLWxhYmVsIHsgcGFkZGluZy1yaWdodDoxMHB4OyBkaXNwbGF5OmlubGluZS1ibG9jazsgfQouY29sLXJlc2l6ZXIgewogIHBvc2l0aW9uOmFic29sdXRlOwogIHRvcDowOwogIHJpZ2h0Oi00cHg7CiAgd2lkdGg6OHB4OwogIGhlaWdodDoxMDAlOwogIGN1cnNvcjpjb2wtcmVzaXplOwogIHVzZXItc2VsZWN0Om5vbmU7CiAgdG91Y2gtYWN0aW9uOm5vbmU7CiAgei1pbmRleDoyOwp9Ci5jb2wtcmVzaXplcjo6YWZ0ZXIgewogIGNvbnRlbnQ6Jyc7CiAgcG9zaXRpb246YWJzb2x1dGU7CiAgdG9wOjZweDsKICBib3R0b206NnB4OwogIGxlZnQ6M3B4OwogIHdpZHRoOjFweDsKICBiYWNrZ3JvdW5kOnJnYmEoMTIyLDE0MywxNjgsLjI4KTsKfQouY29sLXJlc2l6ZXI6aG92ZXI6OmFmdGVyLAouY29sLXJlc2l6ZXIuYWN0aXZlOjphZnRlciB7CiAgYmFja2dyb3VuZDpyZ2JhKDEyMiwxNDMsMTY4LC43NSk7Cn0KCi5zYmFkZ2UgewogIGRpc3BsYXk6aW5saW5lLWJsb2NrOyBmb250LXNpemU6OXB4OyBmb250LXdlaWdodDo3MDA7CiAgbGV0dGVyLXNwYWNpbmc6LjA4ZW07IHBhZGRpbmc6MnB4IDdweDsgYm9yZGVyLXJhZGl1czo0cHg7CiAgdGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOwp9Ci5zYmFkZ2Uuc2ltIHsgYmFja2dyb3VuZDp2YXIoLS1ncmVlbi1kKTsgY29sb3I6dmFyKC0tZ3JlZW4pOyBib3JkZXI6MXB4IHNvbGlkIHJnYmEoMCwyMzAsMTE4LC4yKTsgfQouc2JhZGdlLm5vc2ltIHsgYmFja2dyb3VuZDp2YXIoLS1yZWQtZCk7IGNvbG9yOnZhcigtLXJlZCk7IGJvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsNzEsODcsLjIpOyB9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgRk9PVEVSIC8gR0xPU0FSSU8K4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5nbG9zYXJpbyB7CiAgbWFyZ2luLXRvcDoyMHB4OyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czoxMXB4OyBvdmVyZmxvdzpoaWRkZW47CiAgYW5pbWF0aW9uOmZhZGVVcCAuNXMgLjZzIGVhc2UgYm90aDsKfQouZ2xvcy1idG4gewogIHdpZHRoOjEwMCU7IGJhY2tncm91bmQ6dmFyKC0tc3VyZik7IGJvcmRlcjpub25lOwogIGNvbG9yOnZhcigtLW11dGVkMik7IGZvbnQtZmFtaWx5OnZhcigtLW1vbm8pOyBmb250LXNpemU6MTFweDsKICBwYWRkaW5nOjEzcHggMjJweDsgdGV4dC1hbGlnbjpsZWZ0OyBjdXJzb3I6cG9pbnRlcjsKICBkaXNwbGF5OmZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsganVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47CiAgdHJhbnNpdGlvbjpjb2xvciAuMTVzOwp9Ci5nbG9zLWJ0bjpob3ZlciB7IGNvbG9yOnZhcigtLXRleHQpOyB9CgouZ2xvcy1ncmlkIHsKICBkaXNwbGF5Om5vbmU7IGdyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyOwogIGJhY2tncm91bmQ6dmFyKC0tc3VyZjIpOyBib3JkZXItdG9wOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwp9Ci5nbG9zLWdyaWQub3BlbiB7IGRpc3BsYXk6Z3JpZDsgfQoKLmdpIHsKICBwYWRkaW5nOjE0cHggMjJweDsgYm9yZGVyLWJvdHRvbToxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmlnaHQ6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Cn0KLmdpOm50aC1jaGlsZChldmVuKXtib3JkZXItcmlnaHQ6bm9uZTt9Ci5naS10ZXJtIHsKICBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC1zaXplOjEwcHg7IGZvbnQtd2VpZ2h0OjcwMDsKICBsZXR0ZXItc3BhY2luZzouMDhlbTsgdGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOyBjb2xvcjp2YXIoLS1tdXRlZDIpOyBtYXJnaW4tYm90dG9tOjNweDsKfQouZ2ktZGVmIHsgZm9udC1zaXplOjExcHg7IGNvbG9yOnZhcigtLW11dGVkKTsgbGluZS1oZWlnaHQ6MS41OyB9Cgpmb290ZXIgewogIHRleHQtYWxpZ246Y2VudGVyOyBwYWRkaW5nOjIycHg7IGZvbnQtc2l6ZToxMHB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7CiAgYm9yZGVyLXRvcDoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKfQpmb290ZXIgYSB7IGNvbG9yOnZhcigtLW11dGVkMik7IHRleHQtZGVjb3JhdGlvbjpub25lOyB9CmZvb3RlciBhOmhvdmVyIHsgY29sb3I6dmFyKC0tdGV4dCk7IH0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBBTklNQVRJT05TCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwpAa2V5ZnJhbWVzIGZhZGVJbiB7IGZyb217b3BhY2l0eTowO310b3tvcGFjaXR5OjE7fSB9CkBrZXlmcmFtZXMgZmFkZVVwIHsgZnJvbXtvcGFjaXR5OjA7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoMTBweCk7fXRve29wYWNpdHk6MTt0cmFuc2Zvcm06dHJhbnNsYXRlWSgwKTt9IH0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBSRVNQT05TSVZFCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwpAbWVkaWEobWF4LXdpZHRoOjkwMHB4KXsKICA6cm9vdHsgLS1kcmF3ZXItdzogMTAwdnc7IH0KICAuYm9keS13cmFwLmRyYXdlci1vcGVuIC5tYWluLWNvbnRlbnQgeyBtYXJnaW4tcmlnaHQ6MDsgfQogIC5kcmF3ZXIgeyB3aWR0aDoxMDB2dzsgfQp9CkBtZWRpYShtYXgtd2lkdGg6NzAwcHgpewogIC5oZXJvLWdyaWR7IGdyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyOyB9CiAgLmhjYXJkLmdhcHsgZ3JpZC1jb2x1bW46c3BhbiAyOyB9CiAgLm1ldHJpY3MtZ3JpZHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnI7IH0KICAuaGNhcmQtdmFseyBmb250LXNpemU6MjZweDsgfQogIC5waWxsc3sgZmxleC13cmFwOndyYXA7IH0KICAudGFibGUtcmlnaHQgeyBnYXA6OHB4OyB9CiAgLmJ0bi1kb3dubG9hZCB7IHBhZGRpbmc6MCA4cHg7IH0KICB0aGVhZCB0aDpudGgtY2hpbGQoNCksIHRib2R5IHRkOm50aC1jaGlsZCg0KXsgZGlzcGxheTpub25lOyB9CiAgLnMtcmlnaHQgeyBkaXNwbGF5Om5vbmU7IH0KICB0ZC5kaW0gLnRzLWRheSB7IGZvbnQtc2l6ZTo4cHg7IH0KICB0ZC5kaW0gLnRzLWhvdXIgeyBmb250LXNpemU6MTBweDsgfQp9CkBtZWRpYShtYXgtd2lkdGg6NDgwcHgpewogIC5oZXJvLWdyaWR7IGdyaWQtdGVtcGxhdGUtY29sdW1uczoxZnI7IH0KICAuaGNhcmQuZ2FweyBncmlkLWNvbHVtbjpzcGFuIDE7IH0KICBoZWFkZXJ7IHBhZGRpbmc6MCAxNHB4OyB9CiAgLnRhZy1tZXJjYWRveyBkaXNwbGF5Om5vbmU7IH0KICAuYnRuLXRhc2FzIHNwYW4ubGFiZWwtbG9uZyB7IGRpc3BsYXk6bm9uZTsgfQp9CgovKiBEUkFXRVIgT1ZFUkxBWSAobW9iaWxlKSAqLwoub3ZlcmxheSB7CiAgZGlzcGxheTpub25lOwogIHBvc2l0aW9uOmZpeGVkOyBpbnNldDowOyB6LWluZGV4OjE0MDsKICBiYWNrZ3JvdW5kOnJnYmEoMCwwLDAsLjU1KTsKICBiYWNrZHJvcC1maWx0ZXI6Ymx1cigycHgpOwp9CkBtZWRpYShtYXgtd2lkdGg6OTAwcHgpewogIC5vdmVybGF5LnNob3cgeyBkaXNwbGF5OmJsb2NrOyB9Cn0KPC9zdHlsZT4KPC9oZWFkPgo8Ym9keT4KPGRpdiBjbGFzcz0iYXBwIj4KCjwhLS0g4pSA4pSAIEhFQURFUiDilIDilIAgLS0+CjxoZWFkZXI+CiAgPGRpdiBjbGFzcz0ibG9nbyI+CiAgICA8c3BhbiBjbGFzcz0ibGl2ZS1kb3QiPjwvc3Bhbj4KICAgIFJBREFSIE1FUC9DQ0wKICA8L2Rpdj4KICA8ZGl2IGNsYXNzPSJoZWFkZXItcmlnaHQiPgogICAgPGRpdiBjbGFzcz0iZnJlc2gtYmFkZ2UiIGlkPSJmcmVzaC1iYWRnZSI+CiAgICAgIDxzcGFuIGNsYXNzPSJmcmVzaC1kb3QiPjwvc3Bhbj4KICAgICAgPHNwYW4gaWQ9ImZyZXNoLWJhZGdlLXRleHQiPkFjdHVhbGl6YW5kb+KApjwvc3Bhbj4KICAgIDwvZGl2PgogICAgPHNwYW4gY2xhc3M9InRhZy1tZXJjYWRvIGNsb3NlZCIgaWQ9InRhZy1tZXJjYWRvIj5NZXJjYWRvIGNlcnJhZG88L3NwYW4+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLXRhc2FzIiBpZD0iYnRuVGFzYXMiIG9uY2xpY2s9InRvZ2dsZURyYXdlcigpIj4KICAgICAg8J+TiiA8c3BhbiBjbGFzcz0ibGFiZWwtbG9uZyI+Rm9uZG9zIENvbXVuZXMgZGUgSW52ZXJzacOzbjwvc3Bhbj4KICAgIDwvYnV0dG9uPgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1hbGVydCI+8J+UlCBBbGVydGFzPC9idXR0b24+CiAgPC9kaXY+CjwvaGVhZGVyPgoKPCEtLSDilIDilIAgT1ZFUkxBWSAobW9iaWxlKSDilIDilIAgLS0+CjxkaXYgY2xhc3M9Im92ZXJsYXkiIGlkPSJvdmVybGF5IiBvbmNsaWNrPSJ0b2dnbGVEcmF3ZXIoKSI+PC9kaXY+Cgo8IS0tIOKUgOKUgCBCT0RZIFdSQVAg4pSA4pSAIC0tPgo8ZGl2IGNsYXNzPSJib2R5LXdyYXAiIGlkPSJib2R5V3JhcCI+CgogIDwhLS0g4pWQ4pWQ4pWQ4pWQIE1BSU4g4pWQ4pWQ4pWQ4pWQIC0tPgogIDxkaXYgY2xhc3M9Im1haW4tY29udGVudCI+CgogICAgPCEtLSBTVEFUVVMgQkFOTkVSIC0tPgogICAgPGRpdiBjbGFzcz0ic3RhdHVzLWJhbm5lciBzaW1pbGFyIiBpZD0ic3RhdHVzLWJhbm5lciI+CiAgICAgIDxkaXYgY2xhc3M9InMtbGVmdCI+CiAgICAgICAgPGRpdiBjbGFzcz0icy10aXRsZSI+CiAgICAgICAgICA8c3BhbiBpZD0ic3RhdHVzLWxhYmVsIj5NRVAg4omIIENDTDwvc3Bhbj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJzLWJhZGdlIiBpZD0ic3RhdHVzLWJhZGdlIj5TaW1pbGFyPC9zcGFuPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InMtc3ViIj5MYSBicmVjaGEgZXN0w6EgZGVudHJvIGRlbCB1bWJyYWwg4oCUIGxvcyBwcmVjaW9zIHNvbiBjb21wYXJhYmxlczwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0icy1yaWdodCI+CiAgICAgICAgPGRpdj7Dmmx0aW1hIGNvcnJpZGE6IDxzdHJvbmcgaWQ9Imxhc3QtcnVuLXRpbWUiPuKAlDwvc3Ryb25nPjwvZGl2PgogICAgICAgIDxkaXYgaWQ9ImNvdW50ZG93bi10ZXh0Ij5QcsOzeGltYSBhY3R1YWxpemFjacOzbiBlbiA1OjAwPC9kaXY+CiAgICAgICAgPGRpdj5Dcm9uIEdNVC0zIMK3IEx1buKAk1ZpZSAxMDozMOKAkzE4OjAwPC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJlcnJvci1iYW5uZXIiIGlkPSJlcnJvci1iYW5uZXIiPgogICAgICA8c3BhbiBpZD0iZXJyb3ItYmFubmVyLXRleHQiPkVycm9yIGFsIGFjdHVhbGl6YXIgwrcgUmVpbnRlbnRhcjwvc3Bhbj4KICAgICAgPGJ1dHRvbiBpZD0iZXJyb3ItcmV0cnktYnRuIiB0eXBlPSJidXR0b24iPlJlaW50ZW50YXI8L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDwhLS0gSEVSTyBDQVJEUyAtLT4KICAgIDxkaXYgY2xhc3M9Imhlcm8tZ3JpZCI+CiAgICAgIDxkaXYgY2xhc3M9ImhjYXJkIG1lcCI+CiAgICAgICAgPGRpdiBjbGFzcz0iYmFyIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC1sYWJlbCI+CiAgICAgICAgICA8c3BhbiBjbGFzcz0iZG90Ij48L3NwYW4+CiAgICAgICAgICA8c3BhbiBjbGFzcz0idGlwIiBkYXRhLXQ9IkTDs2xhciBCb2xzYSDigJQgY29tcHJhL3ZlbnRhIGRlIGJvbm9zIGVuICRBUlMgeSBVU0QiPk1FUCB2ZW50YSDik5g8L3NwYW4+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtdmFsIiBpZD0ibWVwLXZhbCI+JDEuMjY0PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtc3ViIj5kb2xhcml0by5hciDCtyB2ZW50YTwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaGNhcmQgY2NsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJiYXIiPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLWxhYmVsIj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJkb3QiPjwvc3Bhbj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0aXAiIGRhdGEtdD0iQ29udGFkbyBjb24gTGlxdWlkYWNpw7NuIOKAlCBzaW1pbGFyIGFsIE1FUCBjb24gZ2lybyBhbCBleHRlcmlvciI+Q0NMIHZlbnRhIOKTmDwvc3Bhbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC12YWwiIGlkPSJjY2wtdmFsIj4kMS4yNzE8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC1zdWIiPmRvbGFyaXRvLmFyIMK3IHZlbnRhPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoY2FyZCBnYXAiPgogICAgICAgIDxkaXYgY2xhc3M9ImJhciI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtbGFiZWwiPgogICAgICAgICAgPHNwYW4gY2xhc3M9ImRvdCI+PC9zcGFuPgogICAgICAgICAgPHNwYW4gY2xhc3M9InRpcCIgZGF0YS10PSJCcmVjaGEgcmVsYXRpdmEgY29udHJhIGVsIHByb21lZGlvIGVudHJlIE1FUCB5IENDTCI+QnJlY2hhIOKTmDwvc3Bhbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC12YWwiIGlkPSJicmVjaGEtYWJzIj4kNzwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLXBjdCIgaWQ9ImJyZWNoYS1wY3QiPjAuNTUlPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtc3ViIj5kaWZlcmVuY2lhIGFic29sdXRhIMK3IHBvcmNlbnR1YWw8L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8IS0tIENIQVJUIC0tPgogICAgPGRpdiBjbGFzcz0iY2hhcnQtY2FyZCI+CiAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0LXRvcCI+CiAgICAgICAgPGRpdiBjbGFzcz0iY2hhcnQtdHRsIiBpZD0idHJlbmQtdGl0bGUiPlRlbmRlbmNpYSBNRVAvQ0NMIOKAlCAxIGTDrWE8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJwaWxscyI+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJwaWxsIG9uIiBkYXRhLWZpbHRlcj0iMWQiPjEgRMOtYTwvYnV0dG9uPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0icGlsbCIgZGF0YS1maWx0ZXI9IjF3Ij4xIFNlbWFuYTwvYnV0dG9uPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0icGlsbCIgZGF0YS1maWx0ZXI9IjFtIj4xIE1lczwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ibGVnZW5kcyI+CiAgICAgICAgPGRpdiBjbGFzcz0ibGVnIj48ZGl2IGNsYXNzPSJsZWctbGluZSIgc3R5bGU9ImJhY2tncm91bmQ6dmFyKC0tbWVwKSI+PC9kaXY+TUVQPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibGVnIj48ZGl2IGNsYXNzPSJsZWctbGluZSIgc3R5bGU9ImJhY2tncm91bmQ6dmFyKC0tY2NsKSI+PC9kaXY+Q0NMPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8c3ZnIGNsYXNzPSJjaGFydCIgaWQ9InRyZW5kLWNoYXJ0IiB2aWV3Qm94PSIwIDAgODYwIDE2MCIgcHJlc2VydmVBc3BlY3RSYXRpbz0ibm9uZSI+CiAgICAgICAgPGxpbmUgeDE9IjAiIHkxPSI0MCIgeDI9Ijg2MCIgeTI9IjQwIiBzdHJva2U9IiMxZTI1MzAiIHN0cm9rZS13aWR0aD0iMSIvPgogICAgICAgIDxsaW5lIHgxPSIwIiB5MT0iODAiIHgyPSI4NjAiIHkyPSI4MCIgc3Ryb2tlPSIjMWUyNTMwIiBzdHJva2Utd2lkdGg9IjEiLz4KICAgICAgICA8bGluZSB4MT0iMCIgeTE9IjEyMCIgeDI9Ijg2MCIgeTI9IjEyMCIgc3Ryb2tlPSIjMWUyNTMwIiBzdHJva2Utd2lkdGg9IjEiLz4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteS10b3AiIHg9IjIiIHk9IjM3IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjgiIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXktbWlkIiB4PSIyIiB5PSI3NyIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI4IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC15LWxvdyIgeD0iMiIgeT0iMTE3IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjgiIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgPHBvbHlsaW5lIGlkPSJ0cmVuZC1tZXAtbGluZSIgcG9pbnRzPSIiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzI5YjZmNiIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+CiAgICAgICAgPHBvbHlsaW5lIGlkPSJ0cmVuZC1jY2wtbGluZSIgcG9pbnRzPSIiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2IzOWRkYiIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+CiAgICAgICAgPGxpbmUgaWQ9InRyZW5kLWhvdmVyLWxpbmUiIHgxPSIwIiB5MT0iMTgiIHgyPSIwIiB5Mj0iMTMyIiBzdHJva2U9IiMyYTM0NDQiIHN0cm9rZS13aWR0aD0iMSIgb3BhY2l0eT0iMCIvPgogICAgICAgIDxjaXJjbGUgaWQ9InRyZW5kLWhvdmVyLW1lcCIgY3g9IjAiIGN5PSIwIiByPSIzLjUiIGZpbGw9IiMyOWI2ZjYiIG9wYWNpdHk9IjAiLz4KICAgICAgICA8Y2lyY2xlIGlkPSJ0cmVuZC1ob3Zlci1jY2wiIGN4PSIwIiBjeT0iMCIgcj0iMy41IiBmaWxsPSIjYjM5ZGRiIiBvcGFjaXR5PSIwIi8+CiAgICAgICAgPGcgaWQ9InRyZW5kLXRvb2x0aXAiIG9wYWNpdHk9IjAiPgogICAgICAgICAgPHJlY3QgaWQ9InRyZW5kLXRvb2x0aXAtYmciIHg9IjAiIHk9IjAiIHdpZHRoPSIxNDgiIGhlaWdodD0iNTYiIHJ4PSI2IiBmaWxsPSIjMTYxYjIyIiBzdHJva2U9IiMyYTM0NDQiLz4KICAgICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC10aXAtdGltZSIgeD0iMTAiIHk9IjE0IiBmaWxsPSIjNTU2MDcwIiBmb250LXNpemU9IjgiIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgICA8dGV4dCBpZD0idHJlbmQtdGlwLW1lcCIgeD0iMTAiIHk9IjI4IiBmaWxsPSIjMjliNmY2IiBmb250LXNpemU9IjkiIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj5NRVAg4oCUPC90ZXh0PgogICAgICAgICAgPHRleHQgaWQ9InRyZW5kLXRpcC1jY2wiIHg9IjEwIiB5PSI0MCIgZmlsbD0iI2IzOWRkYiIgZm9udC1zaXplPSI5IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+Q0NMIOKAlDwvdGV4dD4KICAgICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC10aXAtZ2FwIiB4PSIxMCIgeT0iNTIiIGZpbGw9IiNmZmNjMDAiIGZvbnQtc2l6ZT0iOCIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPkJyZWNoYSDigJQ8L3RleHQ+CiAgICAgICAgPC9nPgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC14LTEiIHg9IjI4IiB5PSIxNTQiIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iNyIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteC0yIiB4PSIyMTgiIHk9IjE1NCIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI3IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC14LTMiIHg9IjQxOCIgeT0iMTU0IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjciIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXgtNCIgeD0iNjA4IiB5PSIxNTQiIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iNyIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteC01IiB4PSI3OTgiIHk9IjE1NCIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI3IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICA8L3N2Zz4KICAgIDwvZGl2PgoKICAgIDwhLS0gTUVUUklDUyAtLT4KICAgIDxkaXYgY2xhc3M9Im1ldHJpY3MtZ3JpZCI+CiAgICAgIDxkaXYgY2xhc3M9Im1jYXJkIj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1sYWJlbCIgaWQ9Im1ldHJpYy1jb3VudC1sYWJlbCI+TXVlc3RyYXMgMSBkw61hPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtdmFsIiBpZD0ibWV0cmljLWNvdW50LTI0aCI+4oCUPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtc3ViIiBpZD0ibWV0cmljLWNvdW50LXN1YiI+cmVnaXN0cm9zIGRlbCBwZXLDrW9kbyBmaWx0cmFkbzwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ibWNhcmQiPgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLWxhYmVsIiBpZD0ibWV0cmljLXNpbWlsYXItbGFiZWwiPlZlY2VzIHNpbWlsYXI8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC12YWwiIHN0eWxlPSJjb2xvcjp2YXIoLS1ncmVlbikiIGlkPSJtZXRyaWMtc2ltaWxhci0yNGgiPuKAlDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXN1YiIgaWQ9Im1ldHJpYy1zaW1pbGFyLXN1YiI+bW9tZW50b3MgZW4gem9uYSDiiaQxJSBvIOKJpCQxMDwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ibWNhcmQiPgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLWxhYmVsIiBpZD0ibWV0cmljLW1pbi1sYWJlbCI+QnJlY2hhIG3DrW4uPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtdmFsIiBpZD0ibWV0cmljLW1pbi0yNGgiPuKAlDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXN1YiIgaWQ9Im1ldHJpYy1taW4tc3ViIj5tw61uaW1hIGRlbCBwZXLDrW9kbyBmaWx0cmFkbzwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ibWNhcmQiPgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLWxhYmVsIiBpZD0ibWV0cmljLW1heC1sYWJlbCI+QnJlY2hhIG3DoXguPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtdmFsIiBzdHlsZT0iY29sb3I6dmFyKC0teWVsbG93KSIgaWQ9Im1ldHJpYy1tYXgtMjRoIj7igJQ8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1zdWIiIGlkPSJtZXRyaWMtbWF4LXN1YiI+bcOheGltYSBkZWwgcGVyw61vZG8gZmlsdHJhZG88L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8IS0tIFRBQkxFIC0tPgogICAgPGRpdiBjbGFzcz0idGFibGUtY2FyZCI+CiAgICAgIDxkaXYgY2xhc3M9InRhYmxlLXRvcCI+CiAgICAgICAgPGRpdiBjbGFzcz0idGFibGUtdHRsIj5IaXN0b3JpYWwgZGUgcmVnaXN0cm9zPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0idGFibGUtcmlnaHQiPgogICAgICAgICAgPGRpdiBjbGFzcz0idGFibGUtY2FwIiBpZD0iaGlzdG9yeS1jYXAiPsOabHRpbWFzIOKAlCBtdWVzdHJhczwvZGl2PgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuLWRvd25sb2FkIiBpZD0iYnRuLWRvd25sb2FkLWNzdiIgdHlwZT0iYnV0dG9uIiBhcmlhLWxhYmVsPSJEZXNjYXJnYXIgQ1NWIj4KICAgICAgICAgICAgPHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGFyaWEtaGlkZGVuPSJ0cnVlIj4KICAgICAgICAgICAgICA8cGF0aCBkPSJNMTIgNHYxMCI+PC9wYXRoPgogICAgICAgICAgICAgIDxwYXRoIGQ9Ik04IDEwbDQgNCA0LTQiPjwvcGF0aD4KICAgICAgICAgICAgICA8cGF0aCBkPSJNNSAxOWgxNCI+PC9wYXRoPgogICAgICAgICAgICA8L3N2Zz4KICAgICAgICAgICAgRGVzY2FyZ2FyIENTVgogICAgICAgICAgPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoaXN0b3J5LXRhYmxlLXdyYXAiPgogICAgICA8dGFibGUgaWQ9Imhpc3RvcnktdGFibGUiPgogICAgICAgIDxjb2xncm91cCBpZD0iaGlzdG9yeS1jb2xncm91cCI+CiAgICAgICAgICA8Y29sIGRhdGEtY29sLWluZGV4PSIwIj4KICAgICAgICAgIDxjb2wgZGF0YS1jb2wtaW5kZXg9IjEiPgogICAgICAgICAgPGNvbCBkYXRhLWNvbC1pbmRleD0iMiI+CiAgICAgICAgICA8Y29sIGRhdGEtY29sLWluZGV4PSIzIj4KICAgICAgICAgIDxjb2wgZGF0YS1jb2wtaW5kZXg9IjQiPgogICAgICAgICAgPGNvbCBkYXRhLWNvbC1pbmRleD0iNSI+CiAgICAgICAgPC9jb2xncm91cD4KICAgICAgICA8dGhlYWQ+CiAgICAgICAgICA8dHI+CiAgICAgICAgICAgIDx0aD48c3BhbiBjbGFzcz0iY29sLWxhYmVsIj5Ew61hIC8gSG9yYTwvc3Bhbj48c3BhbiBjbGFzcz0iY29sLXJlc2l6ZXIiIGRhdGEtY29sLWluZGV4PSIwIiByb2xlPSJzZXBhcmF0b3IiIGFyaWEtbGFiZWw9IkFqdXN0YXIgYW5jaG8gZGUgRMOtYSAvIEhvcmEiPjwvc3Bhbj48L3RoPgogICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImNvbC1sYWJlbCI+TUVQPC9zcGFuPjxzcGFuIGNsYXNzPSJjb2wtcmVzaXplciIgZGF0YS1jb2wtaW5kZXg9IjEiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBNRVAiPjwvc3Bhbj48L3RoPgogICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImNvbC1sYWJlbCI+Q0NMPC9zcGFuPjxzcGFuIGNsYXNzPSJjb2wtcmVzaXplciIgZGF0YS1jb2wtaW5kZXg9IjIiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBDQ0wiPjwvc3Bhbj48L3RoPgogICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImNvbC1sYWJlbCI+RGlmICQ8L3NwYW4+PHNwYW4gY2xhc3M9ImNvbC1yZXNpemVyIiBkYXRhLWNvbC1pbmRleD0iMyIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIERpZiAkIj48L3NwYW4+PC90aD4KICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJjb2wtbGFiZWwiPkRpZiAlPC9zcGFuPjxzcGFuIGNsYXNzPSJjb2wtcmVzaXplciIgZGF0YS1jb2wtaW5kZXg9IjQiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBEaWYgJSI+PC9zcGFuPjwvdGg+CiAgICAgICAgICAgIDx0aD48c3BhbiBjbGFzcz0iY29sLWxhYmVsIj5Fc3RhZG88L3NwYW4+PHNwYW4gY2xhc3M9ImNvbC1yZXNpemVyIiBkYXRhLWNvbC1pbmRleD0iNSIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIEVzdGFkbyI+PC9zcGFuPjwvdGg+CiAgICAgICAgICA8L3RyPgogICAgICAgIDwvdGhlYWQ+CiAgICAgICAgPHRib2R5IGlkPSJoaXN0b3J5LXJvd3MiPjwvdGJvZHk+CiAgICAgIDwvdGFibGU+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgPCEtLSBHTE9TQVJJTyAtLT4KICAgIDxkaXYgY2xhc3M9Imdsb3NhcmlvIj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iZ2xvcy1idG4iIG9uY2xpY2s9InRvZ2dsZUdsb3ModGhpcykiPgogICAgICAgIDxzcGFuPvCfk5YgR2xvc2FyaW8gZGUgdMOpcm1pbm9zPC9zcGFuPgogICAgICAgIDxzcGFuIGlkPSJnbG9zQXJyb3ciPuKWvjwvc3Bhbj4KICAgICAgPC9idXR0b24+CiAgICAgIDxkaXYgY2xhc3M9Imdsb3MtZ3JpZCIgaWQ9Imdsb3NHcmlkIj4KICAgICAgICA8ZGl2IGNsYXNzPSJnaSI+PGRpdiBjbGFzcz0iZ2ktdGVybSI+TUVQIHZlbnRhPC9kaXY+PGRpdiBjbGFzcz0iZ2ktZGVmIj5QcmVjaW8gZGUgdmVudGEgZGVsIGTDs2xhciBNRVAgKE1lcmNhZG8gRWxlY3Ryw7NuaWNvIGRlIFBhZ29zKSB2w61hIGNvbXByYS92ZW50YSBkZSBib25vcyBlbiAkQVJTIHkgVVNELjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImdpIj48ZGl2IGNsYXNzPSJnaS10ZXJtIj5DQ0wgdmVudGE8L2Rpdj48ZGl2IGNsYXNzPSJnaS1kZWYiPkNvbnRhZG8gY29uIExpcXVpZGFjacOzbiDigJQgc2ltaWxhciBhbCBNRVAgcGVybyBwZXJtaXRlIHRyYW5zZmVyaXIgZm9uZG9zIGFsIGV4dGVyaW9yLiBTdWVsZSBjb3RpemFyIGxldmVtZW50ZSBwb3IgZW5jaW1hLjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImdpIj48ZGl2IGNsYXNzPSJnaS10ZXJtIj5EaWZlcmVuY2lhICU8L2Rpdj48ZGl2IGNsYXNzPSJnaS1kZWYiPkJyZWNoYSByZWxhdGl2YSBjYWxjdWxhZGEgY29udHJhIGVsIHByb21lZGlvIGVudHJlIE1FUCB5IENDTC4gVW1icmFsIFNJTUlMQVI6IOKJpCAxJSBvIOKJpCAkMTAgQVJTLjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImdpIj48ZGl2IGNsYXNzPSJnaS10ZXJtIj5GcmVzY3VyYSBkZWwgZGF0bzwvZGl2PjxkaXYgY2xhc3M9ImdpLWRlZiI+VGllbXBvIGRlc2RlIGVsIMO6bHRpbW8gdGltZXN0YW1wIGRlIGRvbGFyaXRvLmFyLiBFbCBjcm9uIGNvcnJlIGNhZGEgNSBtaW4gZW4gZMOtYXMgaMOhYmlsZXMuPC9kaXY+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZ2kiPjxkaXYgY2xhc3M9ImdpLXRlcm0iPkVzdGFkbyBTSU1JTEFSPC9kaXY+PGRpdiBjbGFzcz0iZ2ktZGVmIj5DdWFuZG8gTUVQIHkgQ0NMIGVzdMOhbiBkZW50cm8gZGVsIHVtYnJhbCDigJQgbW9tZW50byBpZGVhbCBwYXJhIG9wZXJhciBidXNjYW5kbyBwYXJpZGFkIGVudHJlIGFtYm9zIHRpcG9zLjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImdpIj48ZGl2IGNsYXNzPSJnaS10ZXJtIj5NZXJjYWRvIEFSRzwvZGl2PjxkaXYgY2xhc3M9ImdpLWRlZiI+VmVudGFuYSBvcGVyYXRpdmE6IGx1bmVzIGEgdmllcm5lcyBkZSAxMDozMCBhIDE3OjU5IChHTVQtMywgQnVlbm9zIEFpcmVzKS48L2Rpdj48L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8Zm9vdGVyPgogICAgICBGdWVudGU6IDxhIGhyZWY9IiMiPmRvbGFyaXRvLmFyPC9hPiDCtyA8YSBocmVmPSIjIj5hcmdlbnRpbmFkYXRvcy5jb208L2E+IMK3IERhdG9zIGNhZGEgNSBtaW4gZW4gZMOtYXMgaMOhYmlsZXMgwrcgPGEgaHJlZj0iIyI+UmVwb3J0YXIgcHJvYmxlbWE8L2E+CiAgICA8L2Zvb3Rlcj4KCiAgPC9kaXY+PCEtLSAvbWFpbi1jb250ZW50IC0tPgoKICA8IS0tIOKVkOKVkOKVkOKVkCBEUkFXRVIg4pWQ4pWQ4pWQ4pWQIC0tPgogIDxkaXYgY2xhc3M9ImRyYXdlciIgaWQ9ImRyYXdlciI+CgogICAgPGRpdiBjbGFzcz0iZHJhd2VyLWhlYWRlciI+CiAgICAgIDxkaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZHJhd2VyLXRpdGxlIj7wn5OKIEZvbmRvcyBDb211bmVzIGRlIEludmVyc2nDs248L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJkcmF3ZXItc291cmNlIj5GdWVudGVzOiBhcmdlbnRpbmFkYXRvcy5jb208L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0bi1jbG9zZSIgb25jbGljaz0idG9nZ2xlRHJhd2VyKCkiPuKclTwvYnV0dG9uPgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iZHJhd2VyLWJvZHkiPgogICAgICA8ZGl2IGNsYXNzPSJmY2ktaGVhZGVyIj4KICAgICAgICA8ZGl2IGNsYXNzPSJmY2ktdGl0bGUiPlJlbnRhIGZpamEgKEZDSSBBcmdlbnRpbmEpPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmNpLW1ldGEiIGlkPSJmY2ktbGFzdC1kYXRlIj5GZWNoYTog4oCUPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmY2ktY29udHJvbHMiPgogICAgICAgIDxpbnB1dCBpZD0iZmNpLXNlYXJjaCIgY2xhc3M9ImZjaS1zZWFyY2giIHR5cGU9InRleHQiIHBsYWNlaG9sZGVyPSJCdXNjYXIgZm9uZG8uLi4iIC8+CiAgICAgICAgPGRpdiBjbGFzcz0iZmNpLXBhZ2luYXRpb24iPgogICAgICAgICAgPGJ1dHRvbiBpZD0iZmNpLXByZXYiIGNsYXNzPSJmY2ktcGFnZS1idG4iIHR5cGU9ImJ1dHRvbiI+4peAPC9idXR0b24+CiAgICAgICAgICA8ZGl2IGlkPSJmY2ktcGFnZS1pbmZvIiBjbGFzcz0iZmNpLXBhZ2UtaW5mbyI+MSAvIDE8L2Rpdj4KICAgICAgICAgIDxidXR0b24gaWQ9ImZjaS1uZXh0IiBjbGFzcz0iZmNpLXBhZ2UtYnRuIiB0eXBlPSJidXR0b24iPuKWtjwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmNpLXRhYmxlLXdyYXAiPgogICAgICAgIDx0YWJsZSBjbGFzcz0iZmNpLXRhYmxlIj4KICAgICAgICAgIDx0aGVhZD4KICAgICAgICAgICAgPHRyPgogICAgICAgICAgICAgIDx0aD48c3BhbiBjbGFzcz0idGlwIHRpcC1kb3duIiB0aXRsZT0iTm9tYnJlIGRlbCBGb25kbyBDb23Dum4gZGUgSW52ZXJzacOzbi4iIGRhdGEtdD0iTm9tYnJlIGRlbCBGb25kbyBDb23Dum4gZGUgSW52ZXJzacOzbi4iPkZvbmRvIOKTmDwvc3Bhbj48L3RoPgogICAgICAgICAgICAgIDx0aD48c3BhbiBjbGFzcz0idGlwIHRpcC1kb3duIiB0aXRsZT0iVkNQIOKAlCBWYWxvciBDdW90YXBhcnRlLiBQcmVjaW8gdW5pdGFyaW8gZGUgY2FkYSBjdW90YXBhcnRlLiBVc2FsbyBwYXJhIGNvbXBhcmFyIHJlbmRpbWllbnRvIGVudHJlIGZlY2hhcy4iIGRhdGEtdD0iVkNQIOKAlCBWYWxvciBDdW90YXBhcnRlLiBQcmVjaW8gdW5pdGFyaW8gZGUgY2FkYSBjdW90YXBhcnRlLiBVc2FsbyBwYXJhIGNvbXBhcmFyIHJlbmRpbWllbnRvIGVudHJlIGZlY2hhcy4iPlZDUCDik5g8L3NwYW4+PC90aD4KICAgICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9InRpcCB0aXAtZG93biIgdGl0bGU9IkNDUCDigJQgQ2FudGlkYWQgZGUgQ3VvdGFwYXJ0ZXMuIFRvdGFsIGRlIGN1b3RhcGFydGVzIGVtaXRpZGFzLiBTdWJlIGN1YW5kbyBlbnRyYW4gaW52ZXJzb3JlcywgYmFqYSBjdWFuZG8gcmVzY2F0YW4uIiBkYXRhLXQ9IkNDUCDigJQgQ2FudGlkYWQgZGUgQ3VvdGFwYXJ0ZXMuIFRvdGFsIGRlIGN1b3RhcGFydGVzIGVtaXRpZGFzLiBTdWJlIGN1YW5kbyBlbnRyYW4gaW52ZXJzb3JlcywgYmFqYSBjdWFuZG8gcmVzY2F0YW4uIj5DQ1Ag4pOYPC9zcGFuPjwvdGg+CiAgICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJ0aXAgdGlwLWRvd24iIHRpdGxlPSJQYXRyaW1vbmlvIOKAlCBWQ1Agw5cgQ0NQLiBWYWxvciB0b3RhbCBhZG1pbmlzdHJhZG8gcG9yIGVsIGZvbmRvIGVuIHBlc29zIGEgZXNhIGZlY2hhLiIgZGF0YS10PSJQYXRyaW1vbmlvIOKAlCBWQ1Agw5cgQ0NQLiBWYWxvciB0b3RhbCBhZG1pbmlzdHJhZG8gcG9yIGVsIGZvbmRvIGVuIHBlc29zIGEgZXNhIGZlY2hhLiI+UGF0cmltb25pbyDik5g8L3NwYW4+PC90aD4KICAgICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9InRpcCB0aXAtZG93biIgdGl0bGU9Ikhvcml6b250ZSBkZSBpbnZlcnNpw7NuIHN1Z2VyaWRvIChjb3J0bywgbWVkaW8gbyBsYXJnbykuIiBkYXRhLXQ9Ikhvcml6b250ZSBkZSBpbnZlcnNpw7NuIHN1Z2VyaWRvIChjb3J0bywgbWVkaW8gbyBsYXJnbykuIj5Ib3Jpem9udGUg4pOYPC9zcGFuPjwvdGg+CiAgICAgICAgICAgIDwvdHI+CiAgICAgICAgICA8L3RoZWFkPgogICAgICAgICAgPHRib2R5IGlkPSJmY2ktcm93cyI+CiAgICAgICAgICAgIDx0cj48dGQgY29sc3Bhbj0iNSIgY2xhc3M9ImRpbSI+Q2FyZ2FuZG/igKY8L3RkPjwvdHI+CiAgICAgICAgICA8L3Rib2R5PgogICAgICAgIDwvdGFibGU+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmY2ktZW1wdHkiIGlkPSJmY2ktZW1wdHkiIHN0eWxlPSJkaXNwbGF5Om5vbmUiPgogICAgICAgIE5vIGhheSBkYXRvcyBkZSByZW50YSBmaWphIGRpc3BvbmlibGVzIGVuIGVzdGUgbW9tZW50by4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImNvbnRleHQtYm94Ij4KICAgICAgICA8c3Ryb25nPlRpcDo8L3N0cm9uZz48YnI+CiAgICAgICAgU2UgbGlzdGFuIGxvcyBmb25kb3MgZGUgcmVudGEgZmlqYSBvcmRlbmFkb3MgcG9yIHBhdHJpbW9uaW8gKGRlIG1heW9yIGEgbWVub3IpLgogICAgICA8L2Rpdj4KICAgIDwvZGl2PjwhLS0gL2RyYXdlci1ib2R5IC0tPgogIDwvZGl2PjwhLS0gL2RyYXdlciAtLT4KCjwvZGl2PjwhLS0gL2JvZHktd3JhcCAtLT4KPC9kaXY+PCEtLSAvYXBwIC0tPgoKPHNjcmlwdD4KICAvLyAxKSBDb25zdGFudGVzIHkgY29uZmlndXJhY2nDs24KICBjb25zdCBFTkRQT0lOVFMgPSB7CiAgICBtZXBDY2w6ICcvYXBpL2RhdGEnLAogICAgZmNpUmVudGFGaWphOiAnaHR0cHM6Ly9hcGkuYXJnZW50aW5hZGF0b3MuY29tL3YxL2ZpbmFuemFzL2ZjaS9yZW50YUZpamEvdWx0aW1vJwogIH07CiAgY29uc3QgQVJHX1RaID0gJ0FtZXJpY2EvQXJnZW50aW5hL0J1ZW5vc19BaXJlcyc7CiAgY29uc3QgRkVUQ0hfSU5URVJWQUxfTVMgPSAzMDAwMDA7CiAgY29uc3QgQ0FDSEVfS0VZID0gJ3JhZGFyX2NhY2hlJzsKICBjb25zdCBISVNUT1JZX0NPTFNfS0VZID0gJ3JhZGFyX2hpc3RvcnlfY29sX3dpZHRoc192MSc7CiAgY29uc3QgQ0FDSEVfVFRMX01TID0gMTUgKiA2MCAqIDEwMDA7CiAgY29uc3QgUkVUUllfREVMQVlTID0gWzEwMDAwLCAzMDAwMCwgNjAwMDBdOwogIGNvbnN0IFNJTUlMQVJfUENUX1RIUkVTSE9MRCA9IDE7CiAgY29uc3QgU0lNSUxBUl9BUlNfVEhSRVNIT0xEID0gMTA7CiAgY29uc3QgVFJFTkRfTUFYX1BPSU5UUyA9IDI0MDsKICBjb25zdCBGQ0lfUEFHRV9TSVpFID0gMTA7CiAgY29uc3QgSElTVE9SWV9ERUZBVUxUX0NPTF9XSURUSFMgPSBbMTcwLCAxNjAsIDE2MCwgMTIwLCAxMjAsIDE3MF07CiAgY29uc3QgSElTVE9SWV9NSU5fQ09MX1dJRFRIUyA9IFsxMjAsIDExMCwgMTEwLCA5MCwgOTAsIDEyMF07CiAgY29uc3QgTlVNRVJJQ19JRFMgPSBbCiAgICAnbWVwLXZhbCcsICdjY2wtdmFsJywgJ2JyZWNoYS1hYnMnLCAnYnJlY2hhLXBjdCcKICBdOwogIGNvbnN0IHN0YXRlID0gewogICAgcmV0cnlJbmRleDogMCwKICAgIHJldHJ5VGltZXI6IG51bGwsCiAgICBsYXN0U3VjY2Vzc0F0OiAwLAogICAgaXNGZXRjaGluZzogZmFsc2UsCiAgICBmaWx0ZXJNb2RlOiAnMWQnLAogICAgbGFzdE1lcFBheWxvYWQ6IG51bGwsCiAgICB0cmVuZFJvd3M6IFtdLAogICAgdHJlbmRIb3ZlckJvdW5kOiBmYWxzZSwKICAgIGhpc3RvcnlSZXNpemVCb3VuZDogZmFsc2UsCiAgICBoaXN0b3J5Q29sV2lkdGhzOiBbXSwKICAgIHNvdXJjZVRzTXM6IG51bGwsCiAgICBmcmVzaEJhZGdlTW9kZTogJ2lkbGUnLAogICAgZnJlc2hUaWNrZXI6IG51bGwsCiAgICBmY2lSb3dzOiBbXSwKICAgIGZjaVF1ZXJ5OiAnJywKICAgIGZjaVBhZ2U6IDEsCiAgICBsYXRlc3Q6IHsKICAgICAgbWVwOiBudWxsLAogICAgICBjY2w6IG51bGwsCiAgICAgIGJyZWNoYUFiczogbnVsbCwKICAgICAgYnJlY2hhUGN0OiBudWxsCiAgICB9CiAgfTsKCiAgLy8gMikgSGVscGVycwogIGNvbnN0IGZtdEFyZ1RpbWUgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZXMtQVInLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgaG91cjogJzItZGlnaXQnLAogICAgbWludXRlOiAnMi1kaWdpdCcKICB9KTsKICBjb25zdCBmbXRBcmdUaW1lU2VjID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VzLUFSJywgewogICAgdGltZVpvbmU6IEFSR19UWiwKICAgIGhvdXI6ICcyLWRpZ2l0JywKICAgIG1pbnV0ZTogJzItZGlnaXQnLAogICAgc2Vjb25kOiAnMi1kaWdpdCcKICB9KTsKICBjb25zdCBmbXRBcmdIb3VyID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VzLUFSJywgewogICAgdGltZVpvbmU6IEFSR19UWiwKICAgIGhvdXI6ICcyLWRpZ2l0JywKICAgIG1pbnV0ZTogJzItZGlnaXQnLAogICAgaG91cjEyOiBmYWxzZQogIH0pOwogIGNvbnN0IGZtdEFyZ0RheU1vbnRoID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VzLUFSJywgewogICAgdGltZVpvbmU6IEFSR19UWiwKICAgIGRheTogJzItZGlnaXQnLAogICAgbW9udGg6ICcyLWRpZ2l0JwogIH0pOwogIGNvbnN0IGZtdEFyZ0RhdGUgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZW4tQ0EnLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgeWVhcjogJ251bWVyaWMnLAogICAgbW9udGg6ICcyLWRpZ2l0JywKICAgIGRheTogJzItZGlnaXQnCiAgfSk7CiAgY29uc3QgZm10QXJnV2Vla2RheSA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlbi1VUycsIHsKICAgIHRpbWVab25lOiBBUkdfVFosCiAgICB3ZWVrZGF5OiAnc2hvcnQnCiAgfSk7CiAgY29uc3QgZm10QXJnUGFydHMgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZW4tVVMnLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgd2Vla2RheTogJ3Nob3J0JywKICAgIGhvdXI6ICcyLWRpZ2l0JywKICAgIG1pbnV0ZTogJzItZGlnaXQnLAogICAgc2Vjb25kOiAnMi1kaWdpdCcsCiAgICBob3VyMTI6IGZhbHNlCiAgfSk7CiAgY29uc3QgV0VFS0RBWSA9IHsgTW9uOiAxLCBUdWU6IDIsIFdlZDogMywgVGh1OiA0LCBGcmk6IDUsIFNhdDogNiwgU3VuOiA3IH07CgogIGZ1bmN0aW9uIHRvTnVtYmVyKHZhbHVlKSB7CiAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpKSByZXR1cm4gdmFsdWU7CiAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykgewogICAgICBjb25zdCBub3JtYWxpemVkID0gdmFsdWUucmVwbGFjZSgvXHMvZywgJycpLnJlcGxhY2UoJywnLCAnLicpLnJlcGxhY2UoL1teXGQuLV0vZywgJycpOwogICAgICBjb25zdCBwYXJzZWQgPSBOdW1iZXIobm9ybWFsaXplZCk7CiAgICAgIHJldHVybiBOdW1iZXIuaXNGaW5pdGUocGFyc2VkKSA/IHBhcnNlZCA6IG51bGw7CiAgICB9CiAgICByZXR1cm4gbnVsbDsKICB9CiAgZnVuY3Rpb24gZ2V0UGF0aChvYmosIHBhdGgpIHsKICAgIHJldHVybiBwYXRoLnJlZHVjZSgoYWNjLCBrZXkpID0+IChhY2MgJiYgYWNjW2tleV0gIT09IHVuZGVmaW5lZCA/IGFjY1trZXldIDogdW5kZWZpbmVkKSwgb2JqKTsKICB9CiAgZnVuY3Rpb24gcGlja051bWJlcihvYmosIHBhdGhzKSB7CiAgICBmb3IgKGNvbnN0IHBhdGggb2YgcGF0aHMpIHsKICAgICAgY29uc3QgdiA9IGdldFBhdGgob2JqLCBwYXRoKTsKICAgICAgY29uc3QgbiA9IHRvTnVtYmVyKHYpOwogICAgICBpZiAobiAhPT0gbnVsbCkgcmV0dXJuIG47CiAgICB9CiAgICByZXR1cm4gbnVsbDsKICB9CiAgZnVuY3Rpb24gcGlja0J5S2V5SGludChvYmosIGhpbnQpIHsKICAgIGlmICghb2JqIHx8IHR5cGVvZiBvYmogIT09ICdvYmplY3QnKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGxvd2VyID0gaGludC50b0xvd2VyQ2FzZSgpOwogICAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXMob2JqKSkgewogICAgICBpZiAoay50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKGxvd2VyKSkgewogICAgICAgIGNvbnN0IG4gPSB0b051bWJlcih2KTsKICAgICAgICBpZiAobiAhPT0gbnVsbCkgcmV0dXJuIG47CiAgICAgICAgaWYgKHYgJiYgdHlwZW9mIHYgPT09ICdvYmplY3QnKSB7CiAgICAgICAgICBjb25zdCBkZWVwID0gcGlja0J5S2V5SGludCh2LCBoaW50KTsKICAgICAgICAgIGlmIChkZWVwICE9PSBudWxsKSByZXR1cm4gZGVlcDsKICAgICAgICB9CiAgICAgIH0KICAgICAgaWYgKHYgJiYgdHlwZW9mIHYgPT09ICdvYmplY3QnKSB7CiAgICAgICAgY29uc3QgZGVlcCA9IHBpY2tCeUtleUhpbnQodiwgaGludCk7CiAgICAgICAgaWYgKGRlZXAgIT09IG51bGwpIHJldHVybiBkZWVwOwogICAgICB9CiAgICB9CiAgICByZXR1cm4gbnVsbDsKICB9CiAgZnVuY3Rpb24gZ2V0QXJnTm93UGFydHMoZGF0ZSA9IG5ldyBEYXRlKCkpIHsKICAgIGNvbnN0IHBhcnRzID0gZm10QXJnUGFydHMuZm9ybWF0VG9QYXJ0cyhkYXRlKS5yZWR1Y2UoKGFjYywgcCkgPT4gewogICAgICBhY2NbcC50eXBlXSA9IHAudmFsdWU7CiAgICAgIHJldHVybiBhY2M7CiAgICB9LCB7fSk7CiAgICByZXR1cm4gewogICAgICB3ZWVrZGF5OiBXRUVLREFZW3BhcnRzLndlZWtkYXldIHx8IDAsCiAgICAgIGhvdXI6IE51bWJlcihwYXJ0cy5ob3VyIHx8ICcwJyksCiAgICAgIG1pbnV0ZTogTnVtYmVyKHBhcnRzLm1pbnV0ZSB8fCAnMCcpLAogICAgICBzZWNvbmQ6IE51bWJlcihwYXJ0cy5zZWNvbmQgfHwgJzAnKQogICAgfTsKICB9CiAgZnVuY3Rpb24gYnJlY2hhUGVyY2VudChtZXAsIGNjbCkgewogICAgaWYgKG1lcCA9PT0gbnVsbCB8fCBjY2wgPT09IG51bGwpIHJldHVybiBudWxsOwogICAgY29uc3QgYXZnID0gKG1lcCArIGNjbCkgLyAyOwogICAgaWYgKCFhdmcpIHJldHVybiBudWxsOwogICAgcmV0dXJuIChNYXRoLmFicyhtZXAgLSBjY2wpIC8gYXZnKSAqIDEwMDsKICB9CiAgZnVuY3Rpb24gZm9ybWF0TW9uZXkodmFsdWUsIGRpZ2l0cyA9IDApIHsKICAgIGlmICh2YWx1ZSA9PT0gbnVsbCkgcmV0dXJuICfigJQnOwogICAgcmV0dXJuICckJyArIHZhbHVlLnRvTG9jYWxlU3RyaW5nKCdlcy1BUicsIHsKICAgICAgbWluaW11bUZyYWN0aW9uRGlnaXRzOiBkaWdpdHMsCiAgICAgIG1heGltdW1GcmFjdGlvbkRpZ2l0czogZGlnaXRzCiAgICB9KTsKICB9CiAgZnVuY3Rpb24gZm9ybWF0UGVyY2VudCh2YWx1ZSwgZGlnaXRzID0gMikgewogICAgaWYgKHZhbHVlID09PSBudWxsKSByZXR1cm4gJ+KAlCc7CiAgICByZXR1cm4gdmFsdWUudG9GaXhlZChkaWdpdHMpICsgJyUnOwogIH0KICBmdW5jdGlvbiBmb3JtYXRDb21wYWN0TW9uZXkodmFsdWUsIGRpZ2l0cyA9IDIpIHsKICAgIGlmICh2YWx1ZSA9PT0gbnVsbCkgcmV0dXJuICfigJQnOwogICAgcmV0dXJuIHZhbHVlLnRvTG9jYWxlU3RyaW5nKCdlcy1BUicsIHsKICAgICAgbWluaW11bUZyYWN0aW9uRGlnaXRzOiBkaWdpdHMsCiAgICAgIG1heGltdW1GcmFjdGlvbkRpZ2l0czogZGlnaXRzCiAgICB9KTsKICB9CiAgZnVuY3Rpb24gZXNjYXBlSHRtbCh2YWx1ZSkgewogICAgcmV0dXJuIFN0cmluZyh2YWx1ZSA/PyAnJykucmVwbGFjZSgvWyY8PiInXS9nLCAoY2hhcikgPT4gKAogICAgICB7ICcmJzogJyZhbXA7JywgJzwnOiAnJmx0OycsICc+JzogJyZndDsnLCAnIic6ICcmcXVvdDsnLCAiJyI6ICcmIzM5OycgfVtjaGFyXQogICAgKSk7CiAgfQogIGZ1bmN0aW9uIHNldFRleHQoaWQsIHRleHQsIG9wdGlvbnMgPSB7fSkgewogICAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7CiAgICBpZiAoIWVsKSByZXR1cm47CiAgICBjb25zdCBuZXh0ID0gU3RyaW5nKHRleHQpOwogICAgY29uc3QgcHJldiA9IGVsLnRleHRDb250ZW50OwogICAgZWwudGV4dENvbnRlbnQgPSBuZXh0OwogICAgZWwuY2xhc3NMaXN0LnJlbW92ZSgnc2tlbGV0b24nKTsKICAgIGlmIChvcHRpb25zLmNoYW5nZUNsYXNzICYmIHByZXYgIT09IG5leHQpIHsKICAgICAgZWwuY2xhc3NMaXN0LmFkZCgndmFsdWUtY2hhbmdlZCcpOwogICAgICBzZXRUaW1lb3V0KCgpID0+IGVsLmNsYXNzTGlzdC5yZW1vdmUoJ3ZhbHVlLWNoYW5nZWQnKSwgNjAwKTsKICAgIH0KICB9CiAgZnVuY3Rpb24gc2V0RGFzaChpZHMpIHsKICAgIGlkcy5mb3JFYWNoKChpZCkgPT4gc2V0VGV4dChpZCwgJ+KAlCcpKTsKICB9CiAgZnVuY3Rpb24gc2V0TG9hZGluZyhpZHMsIGlzTG9hZGluZykgewogICAgaWRzLmZvckVhY2goKGlkKSA9PiB7CiAgICAgIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpOwogICAgICBpZiAoIWVsKSByZXR1cm47CiAgICAgIGVsLmNsYXNzTGlzdC50b2dnbGUoJ3NrZWxldG9uJywgaXNMb2FkaW5nKTsKICAgIH0pOwogIH0KICBmdW5jdGlvbiBzZXRGcmVzaEJhZGdlKHRleHQsIG1vZGUpIHsKICAgIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZyZXNoLWJhZGdlJyk7CiAgICBjb25zdCBsYWJlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmcmVzaC1iYWRnZS10ZXh0Jyk7CiAgICBpZiAoIWJhZGdlIHx8ICFsYWJlbCkgcmV0dXJuOwogICAgbGFiZWwudGV4dENvbnRlbnQgPSB0ZXh0OwogICAgc3RhdGUuZnJlc2hCYWRnZU1vZGUgPSBtb2RlIHx8ICdpZGxlJzsKICAgIGJhZGdlLmNsYXNzTGlzdC50b2dnbGUoJ2ZldGNoaW5nJywgbW9kZSA9PT0gJ2ZldGNoaW5nJyk7CiAgICBiYWRnZS5jbGFzc0xpc3QudG9nZ2xlKCdlcnJvcicsIG1vZGUgPT09ICdlcnJvcicpOwogICAgYmFkZ2Uub25jbGljayA9IG1vZGUgPT09ICdlcnJvcicgPyAoKSA9PiBmZXRjaEFsbCh7IG1hbnVhbDogdHJ1ZSB9KSA6IG51bGw7CiAgfQogIGZ1bmN0aW9uIGZvcm1hdFNvdXJjZUFnZUxhYmVsKHRzTXMpIHsKICAgIGxldCBuID0gdG9OdW1iZXIodHNNcyk7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShuKSkgcmV0dXJuIG51bGw7CiAgICBpZiAobiA8IDFlMTIpIG4gKj0gMTAwMDsKICAgIGNvbnN0IGFnZU1pbiA9IE1hdGgubWF4KDAsIE1hdGguZmxvb3IoKERhdGUubm93KCkgLSBuKSAvIDYwMDAwKSk7CiAgICBpZiAoYWdlTWluIDwgNjApIHJldHVybiBgJHthZ2VNaW59IG1pbmA7CiAgICBjb25zdCBoID0gTWF0aC5mbG9vcihhZ2VNaW4gLyA2MCk7CiAgICBjb25zdCBtID0gYWdlTWluICUgNjA7CiAgICByZXR1cm4gbSA9PT0gMCA/IGAke2h9IGhgIDogYCR7aH0gaCAke219IG1pbmA7CiAgfQogIGZ1bmN0aW9uIHJlZnJlc2hGcmVzaEJhZGdlRnJvbVNvdXJjZSgpIHsKICAgIGlmIChzdGF0ZS5mcmVzaEJhZGdlTW9kZSA9PT0gJ2ZldGNoaW5nJyB8fCBzdGF0ZS5mcmVzaEJhZGdlTW9kZSA9PT0gJ2Vycm9yJykgcmV0dXJuOwogICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoc3RhdGUuc291cmNlVHNNcykpIHJldHVybjsKICAgIGNvbnN0IGFnZUxhYmVsID0gZm9ybWF0U291cmNlQWdlTGFiZWwoc3RhdGUuc291cmNlVHNNcyk7CiAgICBpZiAoIWFnZUxhYmVsKSByZXR1cm47CiAgICBzZXRGcmVzaEJhZGdlKGDDmmx0aW1hIGFjdHVhbGl6YWNpw7NuIGhhY2U6ICR7YWdlTGFiZWx9YCwgJ2lkbGUnKTsKICB9CiAgZnVuY3Rpb24gc3RhcnRGcmVzaFRpY2tlcigpIHsKICAgIGlmIChzdGF0ZS5mcmVzaFRpY2tlcikgcmV0dXJuOwogICAgc3RhdGUuZnJlc2hUaWNrZXIgPSBzZXRJbnRlcnZhbChyZWZyZXNoRnJlc2hCYWRnZUZyb21Tb3VyY2UsIDMwMDAwKTsKICB9CiAgZnVuY3Rpb24gc2V0TWFya2V0VGFnKGlzT3BlbikgewogICAgY29uc3QgdGFnID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RhZy1tZXJjYWRvJyk7CiAgICBpZiAoIXRhZykgcmV0dXJuOwogICAgdGFnLnRleHRDb250ZW50ID0gaXNPcGVuID8gJ01lcmNhZG8gYWJpZXJ0bycgOiAnTWVyY2FkbyBjZXJyYWRvJzsKICAgIHRhZy5jbGFzc0xpc3QudG9nZ2xlKCdjbG9zZWQnLCAhaXNPcGVuKTsKICB9CiAgZnVuY3Rpb24gc2V0RXJyb3JCYW5uZXIoc2hvdywgdGV4dCkgewogICAgY29uc3QgYmFubmVyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Vycm9yLWJhbm5lcicpOwogICAgY29uc3QgbGFiZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZXJyb3ItYmFubmVyLXRleHQnKTsKICAgIGlmICghYmFubmVyKSByZXR1cm47CiAgICBpZiAodGV4dCAmJiBsYWJlbCkgbGFiZWwudGV4dENvbnRlbnQgPSB0ZXh0OwogICAgYmFubmVyLmNsYXNzTGlzdC50b2dnbGUoJ3Nob3cnLCAhIXNob3cpOwogIH0KICBmdW5jdGlvbiBleHRyYWN0Um9vdChqc29uKSB7CiAgICByZXR1cm4ganNvbiAmJiB0eXBlb2YganNvbiA9PT0gJ29iamVjdCcgPyAoanNvbi5kYXRhIHx8IGpzb24ucmVzdWx0IHx8IGpzb24pIDoge307CiAgfQogIGZ1bmN0aW9uIG5vcm1hbGl6ZUZjaVJvd3MocGF5bG9hZCkgewogICAgY29uc3Qgcm9vdCA9IGV4dHJhY3RSb290KHBheWxvYWQpOwogICAgaWYgKEFycmF5LmlzQXJyYXkocm9vdCkpIHJldHVybiByb290OwogICAgaWYgKEFycmF5LmlzQXJyYXkocm9vdD8uaXRlbXMpKSByZXR1cm4gcm9vdC5pdGVtczsKICAgIGlmIChBcnJheS5pc0FycmF5KHJvb3Q/LnJvd3MpKSByZXR1cm4gcm9vdC5yb3dzOwogICAgcmV0dXJuIFtdOwogIH0KICBmdW5jdGlvbiBnZXRIaXN0b3J5Q29sRWxlbWVudHMoKSB7CiAgICBjb25zdCBjb2xncm91cCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoaXN0b3J5LWNvbGdyb3VwJyk7CiAgICByZXR1cm4gY29sZ3JvdXAgPyBBcnJheS5mcm9tKGNvbGdyb3VwLnF1ZXJ5U2VsZWN0b3JBbGwoJ2NvbCcpKSA6IFtdOwogIH0KICBmdW5jdGlvbiBjbGFtcEhpc3RvcnlXaWR0aHMod2lkdGhzKSB7CiAgICByZXR1cm4gSElTVE9SWV9ERUZBVUxUX0NPTF9XSURUSFMubWFwKChmYWxsYmFjaywgaSkgPT4gewogICAgICBjb25zdCByYXcgPSBOdW1iZXIod2lkdGhzPy5baV0pOwogICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShyYXcpKSByZXR1cm4gZmFsbGJhY2s7CiAgICAgIGNvbnN0IG1pbiA9IEhJU1RPUllfTUlOX0NPTF9XSURUSFNbaV0gPz8gODA7CiAgICAgIHJldHVybiBNYXRoLm1heChtaW4sIE1hdGgucm91bmQocmF3KSk7CiAgICB9KTsKICB9CiAgZnVuY3Rpb24gc2F2ZUhpc3RvcnlDb2x1bW5XaWR0aHMod2lkdGhzKSB7CiAgICB0cnkgewogICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShISVNUT1JZX0NPTFNfS0VZLCBKU09OLnN0cmluZ2lmeShjbGFtcEhpc3RvcnlXaWR0aHMod2lkdGhzKSkpOwogICAgfSBjYXRjaCAoZSkgewogICAgICBjb25zb2xlLmVycm9yKCdbUmFkYXJNRVBdIG5vIHNlIHB1ZG8gZ3VhcmRhciBhbmNob3MgZGUgY29sdW1uYXMnLCBlKTsKICAgIH0KICB9CiAgZnVuY3Rpb24gbG9hZEhpc3RvcnlDb2x1bW5XaWR0aHMoKSB7CiAgICB0cnkgewogICAgICBjb25zdCByYXcgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShISVNUT1JZX0NPTFNfS0VZKTsKICAgICAgaWYgKCFyYXcpIHJldHVybiBudWxsOwogICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdyk7CiAgICAgIGlmICghQXJyYXkuaXNBcnJheShwYXJzZWQpIHx8IHBhcnNlZC5sZW5ndGggIT09IEhJU1RPUllfREVGQVVMVF9DT0xfV0lEVEhTLmxlbmd0aCkgcmV0dXJuIG51bGw7CiAgICAgIHJldHVybiBjbGFtcEhpc3RvcnlXaWR0aHMocGFyc2VkKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgY29uc29sZS5lcnJvcignW1JhZGFyTUVQXSBhbmNob3MgZGUgY29sdW1uYXMgaW52w6FsaWRvcycsIGUpOwogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICB9CiAgZnVuY3Rpb24gYXBwbHlIaXN0b3J5Q29sdW1uV2lkdGhzKHdpZHRocywgcGVyc2lzdCA9IGZhbHNlKSB7CiAgICBjb25zdCBjb2xzID0gZ2V0SGlzdG9yeUNvbEVsZW1lbnRzKCk7CiAgICBpZiAoY29scy5sZW5ndGggIT09IEhJU1RPUllfREVGQVVMVF9DT0xfV0lEVEhTLmxlbmd0aCkgcmV0dXJuOwogICAgY29uc3QgbmV4dCA9IGNsYW1wSGlzdG9yeVdpZHRocyh3aWR0aHMpOwogICAgY29scy5mb3JFYWNoKChjb2wsIGkpID0+IHsKICAgICAgY29sLnN0eWxlLndpZHRoID0gYCR7bmV4dFtpXX1weGA7CiAgICB9KTsKICAgIHN0YXRlLmhpc3RvcnlDb2xXaWR0aHMgPSBuZXh0OwogICAgaWYgKHBlcnNpc3QpIHNhdmVIaXN0b3J5Q29sdW1uV2lkdGhzKG5leHQpOwogIH0KICBmdW5jdGlvbiBpbml0SGlzdG9yeUNvbHVtbldpZHRocygpIHsKICAgIGNvbnN0IHNhdmVkID0gbG9hZEhpc3RvcnlDb2x1bW5XaWR0aHMoKTsKICAgIGFwcGx5SGlzdG9yeUNvbHVtbldpZHRocyhzYXZlZCB8fCBISVNUT1JZX0RFRkFVTFRfQ09MX1dJRFRIUywgZmFsc2UpOwogIH0KICBmdW5jdGlvbiBiaW5kSGlzdG9yeUNvbHVtblJlc2l6ZSgpIHsKICAgIGlmIChzdGF0ZS5oaXN0b3J5UmVzaXplQm91bmQpIHJldHVybjsKICAgIGNvbnN0IHRhYmxlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hpc3RvcnktdGFibGUnKTsKICAgIGlmICghdGFibGUpIHJldHVybjsKICAgIGNvbnN0IGhhbmRsZXMgPSBBcnJheS5mcm9tKHRhYmxlLnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb2wtcmVzaXplcicpKTsKICAgIGlmICghaGFuZGxlcy5sZW5ndGgpIHJldHVybjsKICAgIHN0YXRlLmhpc3RvcnlSZXNpemVCb3VuZCA9IHRydWU7CgogICAgaGFuZGxlcy5mb3JFYWNoKChoYW5kbGUpID0+IHsKICAgICAgaGFuZGxlLmFkZEV2ZW50TGlzdGVuZXIoJ2RibGNsaWNrJywgKGV2ZW50KSA9PiB7CiAgICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTsKICAgICAgICBjb25zdCBpZHggPSBOdW1iZXIoaGFuZGxlLmRhdGFzZXQuY29sSW5kZXgpOwogICAgICAgIGlmICghTnVtYmVyLmlzRmluaXRlKGlkeCkpIHJldHVybjsKICAgICAgICBjb25zdCBuZXh0ID0gc3RhdGUuaGlzdG9yeUNvbFdpZHRocy5zbGljZSgpOwogICAgICAgIG5leHRbaWR4XSA9IEhJU1RPUllfREVGQVVMVF9DT0xfV0lEVEhTW2lkeF07CiAgICAgICAgYXBwbHlIaXN0b3J5Q29sdW1uV2lkdGhzKG5leHQsIHRydWUpOwogICAgICB9KTsKICAgICAgaGFuZGxlLmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJkb3duJywgKGV2ZW50KSA9PiB7CiAgICAgICAgaWYgKGV2ZW50LmJ1dHRvbiAhPT0gMCkgcmV0dXJuOwogICAgICAgIGNvbnN0IGlkeCA9IE51bWJlcihoYW5kbGUuZGF0YXNldC5jb2xJbmRleCk7CiAgICAgICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoaWR4KSkgcmV0dXJuOwogICAgICAgIGNvbnN0IHN0YXJ0WCA9IGV2ZW50LmNsaWVudFg7CiAgICAgICAgY29uc3Qgc3RhcnRXaWR0aCA9IHN0YXRlLmhpc3RvcnlDb2xXaWR0aHNbaWR4XSA/PyBISVNUT1JZX0RFRkFVTFRfQ09MX1dJRFRIU1tpZHhdOwogICAgICAgIGhhbmRsZS5jbGFzc0xpc3QuYWRkKCdhY3RpdmUnKTsKICAgICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpOwoKICAgICAgICBjb25zdCBvbk1vdmUgPSAobW92ZUV2ZW50KSA9PiB7CiAgICAgICAgICBjb25zdCBkZWx0YSA9IG1vdmVFdmVudC5jbGllbnRYIC0gc3RhcnRYOwogICAgICAgICAgY29uc3QgbWluID0gSElTVE9SWV9NSU5fQ09MX1dJRFRIU1tpZHhdID8/IDgwOwogICAgICAgICAgY29uc3QgbmV4dFdpZHRoID0gTWF0aC5tYXgobWluLCBNYXRoLnJvdW5kKHN0YXJ0V2lkdGggKyBkZWx0YSkpOwogICAgICAgICAgY29uc3QgbmV4dCA9IHN0YXRlLmhpc3RvcnlDb2xXaWR0aHMuc2xpY2UoKTsKICAgICAgICAgIG5leHRbaWR4XSA9IG5leHRXaWR0aDsKICAgICAgICAgIGFwcGx5SGlzdG9yeUNvbHVtbldpZHRocyhuZXh0LCBmYWxzZSk7CiAgICAgICAgfTsKICAgICAgICBjb25zdCBvblVwID0gKCkgPT4gewogICAgICAgICAgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJtb3ZlJywgb25Nb3ZlKTsKICAgICAgICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKCdwb2ludGVydXAnLCBvblVwKTsKICAgICAgICAgIGhhbmRsZS5jbGFzc0xpc3QucmVtb3ZlKCdhY3RpdmUnKTsKICAgICAgICAgIHNhdmVIaXN0b3J5Q29sdW1uV2lkdGhzKHN0YXRlLmhpc3RvcnlDb2xXaWR0aHMpOwogICAgICAgIH07CiAgICAgICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJtb3ZlJywgb25Nb3ZlKTsKICAgICAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigncG9pbnRlcnVwJywgb25VcCk7CiAgICAgIH0pOwogICAgfSk7CiAgfQoKICAvLyAzKSBGdW5jaW9uZXMgZGUgcmVuZGVyCiAgZnVuY3Rpb24gcmVuZGVyTWVwQ2NsKHBheWxvYWQpIHsKICAgIGlmICghcGF5bG9hZCkgewogICAgICBzZXREYXNoKFsnbWVwLXZhbCcsICdjY2wtdmFsJywgJ2JyZWNoYS1hYnMnLCAnYnJlY2hhLXBjdCddKTsKICAgICAgc2V0VGV4dCgnc3RhdHVzLWxhYmVsJywgJ0RhdG9zIGluY29tcGxldG9zJyk7CiAgICAgIHNldFRleHQoJ3N0YXR1cy1iYWRnZScsICdTaW4gZGF0bycpOwogICAgICByZXR1cm47CiAgICB9CiAgICBjb25zdCBkYXRhID0gZXh0cmFjdFJvb3QocGF5bG9hZCk7CiAgICBjb25zdCBjdXJyZW50ID0gZGF0YSAmJiB0eXBlb2YgZGF0YS5jdXJyZW50ID09PSAnb2JqZWN0JyA/IGRhdGEuY3VycmVudCA6IG51bGw7CiAgICBjb25zdCBtZXAgPSBjdXJyZW50ID8gdG9OdW1iZXIoY3VycmVudC5tZXApIDogKHBpY2tOdW1iZXIoZGF0YSwgW1snbWVwJywgJ3ZlbnRhJ10sIFsnbWVwJywgJ3NlbGwnXSwgWydtZXAnXSwgWydtZXBfdmVudGEnXSwgWydkb2xhcl9tZXAnXV0pID8/IHBpY2tCeUtleUhpbnQoZGF0YSwgJ21lcCcpKTsKICAgIGNvbnN0IGNjbCA9IGN1cnJlbnQgPyB0b051bWJlcihjdXJyZW50LmNjbCkgOiAocGlja051bWJlcihkYXRhLCBbWydjY2wnLCAndmVudGEnXSwgWydjY2wnLCAnc2VsbCddLCBbJ2NjbCddLCBbJ2NjbF92ZW50YSddLCBbJ2RvbGFyX2NjbCddXSkgPz8gcGlja0J5S2V5SGludChkYXRhLCAnY2NsJykpOwogICAgY29uc3QgYWJzID0gY3VycmVudCA/IHRvTnVtYmVyKGN1cnJlbnQuYWJzRGlmZikgPz8gKG1lcCAhPT0gbnVsbCAmJiBjY2wgIT09IG51bGwgPyBNYXRoLmFicyhtZXAgLSBjY2wpIDogbnVsbCkgOiAobWVwICE9PSBudWxsICYmIGNjbCAhPT0gbnVsbCA/IE1hdGguYWJzKG1lcCAtIGNjbCkgOiBudWxsKTsKICAgIGNvbnN0IHBjdCA9IGN1cnJlbnQgPyB0b051bWJlcihjdXJyZW50LnBjdERpZmYpID8/IGJyZWNoYVBlcmNlbnQobWVwLCBjY2wpIDogYnJlY2hhUGVyY2VudChtZXAsIGNjbCk7CiAgICBjb25zdCBpc1NpbWlsYXIgPSBjdXJyZW50ICYmIHR5cGVvZiBjdXJyZW50LnNpbWlsYXIgPT09ICdib29sZWFuJwogICAgICA/IGN1cnJlbnQuc2ltaWxhcgogICAgICA6IChwY3QgIT09IG51bGwgJiYgYWJzICE9PSBudWxsICYmIChwY3QgPD0gU0lNSUxBUl9QQ1RfVEhSRVNIT0xEIHx8IGFicyA8PSBTSU1JTEFSX0FSU19USFJFU0hPTEQpKTsKCiAgICBzZXRUZXh0KCdtZXAtdmFsJywgZm9ybWF0TW9uZXkobWVwLCAyKSwgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ2NjbC12YWwnLCBmb3JtYXRNb25leShjY2wsIDIpLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc2V0VGV4dCgnYnJlY2hhLWFicycsIGFicyA9PT0gbnVsbCA/ICfigJQnIDogZm9ybWF0TW9uZXkoYWJzLCAyKSwgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ2JyZWNoYS1wY3QnLCBmb3JtYXRQZXJjZW50KHBjdCwgMiksIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdzdGF0dXMtbGFiZWwnLCBpc1NpbWlsYXIgPyAnTUVQIOKJiCBDQ0wnIDogJ01FUCDiiaAgQ0NMJyk7CiAgICBzZXRUZXh0KCdzdGF0dXMtYmFkZ2UnLCBpc1NpbWlsYXIgPyAnU2ltaWxhcicgOiAnTm8gc2ltaWxhcicpOwogICAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3RhdHVzLWJhZGdlJyk7CiAgICBpZiAoYmFkZ2UpIGJhZGdlLmNsYXNzTGlzdC50b2dnbGUoJ25vc2ltJywgIWlzU2ltaWxhcik7CgogICAgY29uc3QgYmFubmVyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3N0YXR1cy1iYW5uZXInKTsKICAgIGlmIChiYW5uZXIpIHsKICAgICAgYmFubmVyLmNsYXNzTGlzdC50b2dnbGUoJ3NpbWlsYXInLCAhIWlzU2ltaWxhcik7CiAgICAgIGJhbm5lci5jbGFzc0xpc3QudG9nZ2xlKCduby1zaW1pbGFyJywgIWlzU2ltaWxhcik7CiAgICB9CiAgICBjb25zdCBzdWIgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcjc3RhdHVzLWJhbm5lciAucy1zdWInKTsKICAgIGlmIChzdWIpIHsKICAgICAgc3ViLnRleHRDb250ZW50ID0gaXNTaW1pbGFyCiAgICAgICAgPyAnTGEgYnJlY2hhIGVzdMOhIGRlbnRybyBkZWwgdW1icmFsIOKAlCBsb3MgcHJlY2lvcyBzb24gY29tcGFyYWJsZXMnCiAgICAgICAgOiAnTGEgYnJlY2hhIHN1cGVyYSBlbCB1bWJyYWwg4oCUIGxvcyBwcmVjaW9zIG5vIHNvbiBjb21wYXJhYmxlcyc7CiAgICB9CiAgICBjb25zdCBpc09wZW4gPSBkYXRhPy5tYXJrZXQgJiYgdHlwZW9mIGRhdGEubWFya2V0LmlzT3BlbiA9PT0gJ2Jvb2xlYW4nID8gZGF0YS5tYXJrZXQuaXNPcGVuIDogbnVsbDsKICAgIGlmIChpc09wZW4gIT09IG51bGwpIHNldE1hcmtldFRhZyhpc09wZW4pOwogICAgc3RhdGUubGF0ZXN0Lm1lcCA9IG1lcDsKICAgIHN0YXRlLmxhdGVzdC5jY2wgPSBjY2w7CiAgICBzdGF0ZS5sYXRlc3QuYnJlY2hhQWJzID0gYWJzOwogICAgc3RhdGUubGF0ZXN0LmJyZWNoYVBjdCA9IHBjdDsKICB9CgogIGZ1bmN0aW9uIGlzU2ltaWxhclJvdyhyb3cpIHsKICAgIGNvbnN0IGFicyA9IHJvdy5hYnNfZGlmZiAhPSBudWxsID8gcm93LmFic19kaWZmIDogTWF0aC5hYnMocm93Lm1lcCAtIHJvdy5jY2wpOwogICAgY29uc3QgcGN0ID0gcm93LnBjdF9kaWZmICE9IG51bGwgPyByb3cucGN0X2RpZmYgOiBjYWxjQnJlY2hhUGN0KHJvdy5tZXAsIHJvdy5jY2wpOwogICAgcmV0dXJuIChOdW1iZXIuaXNGaW5pdGUocGN0KSAmJiBwY3QgPD0gU0lNSUxBUl9QQ1RfVEhSRVNIT0xEKSB8fCAoTnVtYmVyLmlzRmluaXRlKGFicykgJiYgYWJzIDw9IFNJTUlMQVJfQVJTX1RIUkVTSE9MRCk7CiAgfQoKICBmdW5jdGlvbiBmaWx0ZXJEZXNjcmlwdG9yKG1vZGUgPSBzdGF0ZS5maWx0ZXJNb2RlKSB7CiAgICBpZiAobW9kZSA9PT0gJzFtJykgcmV0dXJuICcxIE1lcyc7CiAgICBpZiAobW9kZSA9PT0gJzF3JykgcmV0dXJuICcxIFNlbWFuYSc7CiAgICByZXR1cm4gJzEgRMOtYSc7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJNZXRyaWNzMjRoKHBheWxvYWQpIHsKICAgIGNvbnN0IGZpbHRlcmVkID0gZmlsdGVySGlzdG9yeVJvd3MoZXh0cmFjdEhpc3RvcnlSb3dzKHBheWxvYWQpLCBzdGF0ZS5maWx0ZXJNb2RlKTsKICAgIGNvbnN0IHBjdFZhbHVlcyA9IGZpbHRlcmVkLm1hcCgocikgPT4gKHIucGN0X2RpZmYgIT0gbnVsbCA/IHIucGN0X2RpZmYgOiBjYWxjQnJlY2hhUGN0KHIubWVwLCByLmNjbCkpKS5maWx0ZXIoKHYpID0+IE51bWJlci5pc0Zpbml0ZSh2KSk7CiAgICBjb25zdCBzaW1pbGFyQ291bnQgPSBmaWx0ZXJlZC5maWx0ZXIoKHIpID0+IGlzU2ltaWxhclJvdyhyKSkubGVuZ3RoOwogICAgY29uc3QgZGVzY3JpcHRvciA9IGZpbHRlckRlc2NyaXB0b3IoKTsKCiAgICBzZXRUZXh0KCdtZXRyaWMtY291bnQtbGFiZWwnLCBgTXVlc3RyYXMgJHtkZXNjcmlwdG9yfWApOwogICAgc2V0VGV4dCgnbWV0cmljLWNvdW50LTI0aCcsIFN0cmluZyhmaWx0ZXJlZC5sZW5ndGgpLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc2V0VGV4dCgnbWV0cmljLWNvdW50LXN1YicsICdyZWdpc3Ryb3MgZGVsIHBlcsOtb2RvIGZpbHRyYWRvJyk7CiAgICBzZXRUZXh0KCdtZXRyaWMtc2ltaWxhci1sYWJlbCcsIGBWZWNlcyBzaW1pbGFyICgke2Rlc2NyaXB0b3J9KWApOwogICAgc2V0VGV4dCgnbWV0cmljLXNpbWlsYXItMjRoJywgU3RyaW5nKHNpbWlsYXJDb3VudCksIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdtZXRyaWMtc2ltaWxhci1zdWInLCAnbW9tZW50b3MgZW4gem9uYSDiiaQxJSBvIOKJpCQxMCcpOwogICAgc2V0VGV4dCgnbWV0cmljLW1pbi1sYWJlbCcsIGBCcmVjaGEgbcOtbi4gKCR7ZGVzY3JpcHRvcn0pYCk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWluLTI0aCcsIHBjdFZhbHVlcy5sZW5ndGggPyBmb3JtYXRQZXJjZW50KE1hdGgubWluKC4uLnBjdFZhbHVlcyksIDIpIDogJ+KAlCcsIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWluLXN1YicsICdtw61uaW1hIGRlbCBwZXLDrW9kbyBmaWx0cmFkbycpOwogICAgc2V0VGV4dCgnbWV0cmljLW1heC1sYWJlbCcsIGBCcmVjaGEgbcOheC4gKCR7ZGVzY3JpcHRvcn0pYCk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWF4LTI0aCcsIHBjdFZhbHVlcy5sZW5ndGggPyBmb3JtYXRQZXJjZW50KE1hdGgubWF4KC4uLnBjdFZhbHVlcyksIDIpIDogJ+KAlCcsIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWF4LXN1YicsICdtw6F4aW1hIGRlbCBwZXLDrW9kbyBmaWx0cmFkbycpOwogICAgc2V0VGV4dCgndHJlbmQtdGl0bGUnLCBgVGVuZGVuY2lhIE1FUC9DQ0wg4oCUICR7ZGVzY3JpcHRvcn1gKTsKICB9CgogIGZ1bmN0aW9uIHJvd0hvdXJMYWJlbChlcG9jaCkgewogICAgY29uc3QgbiA9IHRvTnVtYmVyKGVwb2NoKTsKICAgIGlmIChuID09PSBudWxsKSByZXR1cm4gJ+KAlCc7CiAgICByZXR1cm4gZm10QXJnSG91ci5mb3JtYXQobmV3IERhdGUobiAqIDEwMDApKTsKICB9CiAgZnVuY3Rpb24gcm93RGF5SG91ckxhYmVsKGVwb2NoKSB7CiAgICBjb25zdCBuID0gdG9OdW1iZXIoZXBvY2gpOwogICAgaWYgKG4gPT09IG51bGwpIHJldHVybiAn4oCUJzsKICAgIGNvbnN0IGRhdGUgPSBuZXcgRGF0ZShuICogMTAwMCk7CiAgICByZXR1cm4gYCR7Zm10QXJnRGF5TW9udGguZm9ybWF0KGRhdGUpfSAke2ZtdEFyZ0hvdXIuZm9ybWF0KGRhdGUpfWA7CiAgfQogIGZ1bmN0aW9uIGFydERhdGVLZXkoZXBvY2gpIHsKICAgIGNvbnN0IG4gPSB0b051bWJlcihlcG9jaCk7CiAgICBpZiAobiA9PT0gbnVsbCkgcmV0dXJuIG51bGw7CiAgICByZXR1cm4gZm10QXJnRGF0ZS5mb3JtYXQobmV3IERhdGUobiAqIDEwMDApKTsKICB9CiAgZnVuY3Rpb24gYXJ0V2Vla2RheShlcG9jaCkgewogICAgY29uc3QgbiA9IHRvTnVtYmVyKGVwb2NoKTsKICAgIGlmIChuID09PSBudWxsKSByZXR1cm4gbnVsbDsKICAgIHJldHVybiBmbXRBcmdXZWVrZGF5LmZvcm1hdChuZXcgRGF0ZShuICogMTAwMCkpOwogIH0KICBmdW5jdGlvbiBleHRyYWN0SGlzdG9yeVJvd3MocGF5bG9hZCkgewogICAgY29uc3QgZGF0YSA9IGV4dHJhY3RSb290KHBheWxvYWQpOwogICAgY29uc3Qgcm93cyA9IEFycmF5LmlzQXJyYXkoZGF0YS5oaXN0b3J5KSA/IGRhdGEuaGlzdG9yeS5zbGljZSgpIDogW107CiAgICByZXR1cm4gcm93cwogICAgICAubWFwKChyKSA9PiAoewogICAgICAgIGVwb2NoOiB0b051bWJlcihyLmVwb2NoKSwKICAgICAgICBtZXA6IHRvTnVtYmVyKHIubWVwKSwKICAgICAgICBjY2w6IHRvTnVtYmVyKHIuY2NsKSwKICAgICAgICBhYnNfZGlmZjogdG9OdW1iZXIoci5hYnNfZGlmZiksCiAgICAgICAgcGN0X2RpZmY6IHRvTnVtYmVyKHIucGN0X2RpZmYpLAogICAgICAgIHNpbWlsYXI6IEJvb2xlYW4oci5zaW1pbGFyKQogICAgICB9KSkKICAgICAgLmZpbHRlcigocikgPT4gci5lcG9jaCAhPSBudWxsICYmIHIubWVwICE9IG51bGwgJiYgci5jY2wgIT0gbnVsbCkKICAgICAgLnNvcnQoKGEsIGIpID0+IGEuZXBvY2ggLSBiLmVwb2NoKTsKICB9CiAgZnVuY3Rpb24gZmlsdGVySGlzdG9yeVJvd3Mocm93cywgbW9kZSkgewogICAgaWYgKCFyb3dzLmxlbmd0aCkgcmV0dXJuIFtdOwogICAgY29uc3QgbGF0ZXN0RXBvY2ggPSByb3dzW3Jvd3MubGVuZ3RoIC0gMV0uZXBvY2g7CiAgICBpZiAobW9kZSA9PT0gJzFtJykgewogICAgICBjb25zdCBjdXRvZmYgPSBsYXRlc3RFcG9jaCAtICgzMCAqIDI0ICogMzYwMCk7CiAgICAgIHJldHVybiByb3dzLmZpbHRlcigocikgPT4gci5lcG9jaCA+PSBjdXRvZmYpOwogICAgfQogICAgaWYgKG1vZGUgPT09ICcxdycpIHsKICAgICAgY29uc3QgYWxsb3dlZERheXMgPSBuZXcgU2V0KCk7CiAgICAgIGZvciAobGV0IGkgPSByb3dzLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7CiAgICAgICAgY29uc3QgZGF5ID0gYXJ0RGF0ZUtleShyb3dzW2ldLmVwb2NoKTsKICAgICAgICBjb25zdCB3ZCA9IGFydFdlZWtkYXkocm93c1tpXS5lcG9jaCk7CiAgICAgICAgaWYgKCFkYXkgfHwgd2QgPT09ICdTYXQnIHx8IHdkID09PSAnU3VuJykgY29udGludWU7CiAgICAgICAgYWxsb3dlZERheXMuYWRkKGRheSk7CiAgICAgICAgaWYgKGFsbG93ZWREYXlzLnNpemUgPj0gNSkgYnJlYWs7CiAgICAgIH0KICAgICAgcmV0dXJuIHJvd3MuZmlsdGVyKChyKSA9PiB7CiAgICAgICAgY29uc3QgZGF5ID0gYXJ0RGF0ZUtleShyLmVwb2NoKTsKICAgICAgICByZXR1cm4gZGF5ICYmIGFsbG93ZWREYXlzLmhhcyhkYXkpOwogICAgICB9KTsKICAgIH0KICAgIGNvbnN0IGN1dG9mZiA9IGxhdGVzdEVwb2NoIC0gKDI0ICogMzYwMCk7CiAgICByZXR1cm4gcm93cy5maWx0ZXIoKHIpID0+IHIuZXBvY2ggPj0gY3V0b2ZmKTsKICB9CiAgZnVuY3Rpb24gZG93bnNhbXBsZVJvd3Mocm93cywgbWF4UG9pbnRzKSB7CiAgICBpZiAocm93cy5sZW5ndGggPD0gbWF4UG9pbnRzKSByZXR1cm4gcm93czsKICAgIGNvbnN0IG91dCA9IFtdOwogICAgY29uc3Qgc3RlcCA9IChyb3dzLmxlbmd0aCAtIDEpIC8gKG1heFBvaW50cyAtIDEpOwogICAgZm9yIChsZXQgaSA9IDA7IGkgPCBtYXhQb2ludHM7IGkrKykgewogICAgICBvdXQucHVzaChyb3dzW01hdGgucm91bmQoaSAqIHN0ZXApXSk7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KICBmdW5jdGlvbiBjdXJyZW50RmlsdGVyTGFiZWwoKSB7CiAgICBpZiAoc3RhdGUuZmlsdGVyTW9kZSA9PT0gJzFtJykgcmV0dXJuICcxIE1lcyc7CiAgICBpZiAoc3RhdGUuZmlsdGVyTW9kZSA9PT0gJzF3JykgcmV0dXJuICcxIFNlbWFuYSc7CiAgICByZXR1cm4gJzEgRMOtYSc7CiAgfQogIGZ1bmN0aW9uIGdldEZpbHRlcmVkSGlzdG9yeVJvd3MocGF5bG9hZCA9IHN0YXRlLmxhc3RNZXBQYXlsb2FkKSB7CiAgICBpZiAoIXBheWxvYWQpIHJldHVybiBbXTsKICAgIHJldHVybiBmaWx0ZXJIaXN0b3J5Um93cyhleHRyYWN0SGlzdG9yeVJvd3MocGF5bG9hZCksIHN0YXRlLmZpbHRlck1vZGUpOwogIH0KICBmdW5jdGlvbiBjc3ZFc2NhcGUodmFsdWUpIHsKICAgIGNvbnN0IHYgPSBTdHJpbmcodmFsdWUgPz8gJycpOwogICAgcmV0dXJuIGAiJHt2LnJlcGxhY2UoLyIvZywgJyIiJyl9ImA7CiAgfQogIGZ1bmN0aW9uIGNzdk51bWJlcih2YWx1ZSwgZGlnaXRzID0gMikgewogICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUodmFsdWUpKSByZXR1cm4gJ+KAlCc7CiAgICByZXR1cm4gdmFsdWUudG9GaXhlZChkaWdpdHMpLnJlcGxhY2UoJy4nLCAnLCcpOwogIH0KICBmdW5jdGlvbiBmaWx0ZXJDb2RlKCkgewogICAgaWYgKHN0YXRlLmZpbHRlck1vZGUgPT09ICcxbScpIHJldHVybiAnMW0nOwogICAgaWYgKHN0YXRlLmZpbHRlck1vZGUgPT09ICcxdycpIHJldHVybiAnMXcnOwogICAgcmV0dXJuICcxZCc7CiAgfQogIGZ1bmN0aW9uIGRvd25sb2FkSGlzdG9yeUNzdigpIHsKICAgIGNvbnN0IGZpbHRlcmVkID0gZ2V0RmlsdGVyZWRIaXN0b3J5Um93cygpOwogICAgaWYgKCFmaWx0ZXJlZC5sZW5ndGgpIHsKICAgICAgc2V0RnJlc2hCYWRnZSgnU2luIGRhdG9zIHBhcmEgZXhwb3J0YXIgZW4gZWwgZmlsdHJvIGFjdGl2bycsICdpZGxlJyk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IGhlYWRlciA9IFsnZmVjaGEnLCAnaG9yYScsICdtZXAnLCAnY2NsJywgJ2RpZl9hYnMnLCAnZGlmX3BjdCcsICdlc3RhZG8nXTsKICAgIGNvbnN0IHJvd3MgPSBmaWx0ZXJlZC5tYXAoKHIpID0+IHsKICAgICAgY29uc3QgZGF0ZSA9IG5ldyBEYXRlKHIuZXBvY2ggKiAxMDAwKTsKICAgICAgY29uc3QgbWVwID0gdG9OdW1iZXIoci5tZXApOwogICAgICBjb25zdCBjY2wgPSB0b051bWJlcihyLmNjbCk7CiAgICAgIGNvbnN0IGFicyA9IHRvTnVtYmVyKHIuYWJzX2RpZmYpOwogICAgICBjb25zdCBwY3QgPSB0b051bWJlcihyLnBjdF9kaWZmKTsKICAgICAgY29uc3QgZXN0YWRvID0gQm9vbGVhbihyLnNpbWlsYXIpID8gJ1NJTUlMQVInIDogJ05PIFNJTUlMQVInOwogICAgICByZXR1cm4gWwogICAgICAgIGZtdEFyZ0RheU1vbnRoLmZvcm1hdChkYXRlKSwKICAgICAgICBmbXRBcmdIb3VyLmZvcm1hdChkYXRlKSwKICAgICAgICBjc3ZOdW1iZXIobWVwLCAyKSwKICAgICAgICBjc3ZOdW1iZXIoY2NsLCAyKSwKICAgICAgICBjc3ZOdW1iZXIoYWJzLCAyKSwKICAgICAgICBjc3ZOdW1iZXIocGN0LCAyKSwKICAgICAgICBlc3RhZG8KICAgICAgXS5tYXAoY3N2RXNjYXBlKS5qb2luKCc7Jyk7CiAgICB9KTsKICAgIGNvbnN0IGFydERhdGUgPSBmbXRBcmdEYXRlLmZvcm1hdChuZXcgRGF0ZSgpKTsKICAgIGNvbnN0IGZpbGVuYW1lID0gYGhpc3RvcmlhbC1tZXAtY2NsLSR7ZmlsdGVyQ29kZSgpfS0ke2FydERhdGV9LmNzdmA7CiAgICBjb25zdCBjc3YgPSAnXHVGRUZGJyArIFtoZWFkZXIuam9pbignOycpLCAuLi5yb3dzXS5qb2luKCdcbicpOwogICAgY29uc3QgYmxvYiA9IG5ldyBCbG9iKFtjc3ZdLCB7IHR5cGU6ICd0ZXh0L2NzdjtjaGFyc2V0PXV0Zi04OycgfSk7CiAgICBjb25zdCB1cmwgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKGJsb2IpOwogICAgY29uc3QgYSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2EnKTsKICAgIGEuaHJlZiA9IHVybDsKICAgIGEuZG93bmxvYWQgPSBmaWxlbmFtZTsKICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoYSk7CiAgICBhLmNsaWNrKCk7CiAgICBhLnJlbW92ZSgpOwogICAgVVJMLnJldm9rZU9iamVjdFVSTCh1cmwpOwogIH0KICBmdW5jdGlvbiBhcHBseUZpbHRlcihtb2RlKSB7CiAgICBzdGF0ZS5maWx0ZXJNb2RlID0gbW9kZTsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5waWxsW2RhdGEtZmlsdGVyXScpLmZvckVhY2goKGJ0bikgPT4gewogICAgICBidG4uY2xhc3NMaXN0LnRvZ2dsZSgnb24nLCBidG4uZGF0YXNldC5maWx0ZXIgPT09IG1vZGUpOwogICAgfSk7CiAgICBpZiAoc3RhdGUubGFzdE1lcFBheWxvYWQpIHsKICAgICAgcmVuZGVyVHJlbmQoc3RhdGUubGFzdE1lcFBheWxvYWQpOwogICAgICByZW5kZXJIaXN0b3J5KHN0YXRlLmxhc3RNZXBQYXlsb2FkKTsKICAgICAgcmVuZGVyTWV0cmljczI0aChzdGF0ZS5sYXN0TWVwUGF5bG9hZCk7CiAgICB9CiAgfQoKICBmdW5jdGlvbiByZW5kZXJIaXN0b3J5KHBheWxvYWQpIHsKICAgIGNvbnN0IHRib2R5ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hpc3Rvcnktcm93cycpOwogICAgY29uc3QgY2FwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hpc3RvcnktY2FwJyk7CiAgICBpZiAoIXRib2R5KSByZXR1cm47CiAgICBjb25zdCBmaWx0ZXJlZCA9IGdldEZpbHRlcmVkSGlzdG9yeVJvd3MocGF5bG9hZCk7CiAgICBjb25zdCByb3dzID0gZmlsdGVyZWQuc2xpY2UoKS5yZXZlcnNlKCk7CiAgICBpZiAoY2FwKSBjYXAudGV4dENvbnRlbnQgPSBgJHtjdXJyZW50RmlsdGVyTGFiZWwoKX0gwrcgJHtyb3dzLmxlbmd0aH0gcmVnaXN0cm9zYDsKICAgIGlmICghcm93cy5sZW5ndGgpIHsKICAgICAgdGJvZHkuaW5uZXJIVE1MID0gJzx0cj48dGQgY2xhc3M9ImRpbSIgY29sc3Bhbj0iNiI+U2luIHJlZ2lzdHJvcyB0b2RhdsOtYTwvdGQ+PC90cj4nOwogICAgICByZXR1cm47CiAgICB9CiAgICB0Ym9keS5pbm5lckhUTUwgPSByb3dzLm1hcCgocikgPT4gewogICAgICBjb25zdCBtZXAgPSB0b051bWJlcihyLm1lcCk7CiAgICAgIGNvbnN0IGNjbCA9IHRvTnVtYmVyKHIuY2NsKTsKICAgICAgY29uc3QgYWJzID0gdG9OdW1iZXIoci5hYnNfZGlmZik7CiAgICAgIGNvbnN0IHBjdCA9IHRvTnVtYmVyKHIucGN0X2RpZmYpOwogICAgICBjb25zdCBzaW0gPSBCb29sZWFuKHIuc2ltaWxhcik7CiAgICAgIHJldHVybiBgPHRyPgogICAgICAgIDx0ZCBjbGFzcz0iZGltIj48ZGl2IGNsYXNzPSJ0cy1kYXkiPiR7Zm10QXJnRGF5TW9udGguZm9ybWF0KG5ldyBEYXRlKHIuZXBvY2ggKiAxMDAwKSl9PC9kaXY+PGRpdiBjbGFzcz0idHMtaG91ciI+JHtyb3dIb3VyTGFiZWwoci5lcG9jaCl9PC9kaXY+PC90ZD4KICAgICAgICA8dGQgc3R5bGU9ImNvbG9yOnZhcigtLW1lcCkiPiR7Zm9ybWF0TW9uZXkobWVwLCAyKX08L3RkPgogICAgICAgIDx0ZCBzdHlsZT0iY29sb3I6dmFyKC0tY2NsKSI+JHtmb3JtYXRNb25leShjY2wsIDIpfTwvdGQ+CiAgICAgICAgPHRkPiR7Zm9ybWF0TW9uZXkoYWJzLCAyKX08L3RkPgogICAgICAgIDx0ZD4ke2Zvcm1hdFBlcmNlbnQocGN0LCAyKX08L3RkPgogICAgICAgIDx0ZD48c3BhbiBjbGFzcz0ic2JhZGdlICR7c2ltID8gJ3NpbScgOiAnbm9zaW0nfSI+JHtzaW0gPyAnU2ltaWxhcicgOiAnTm8gc2ltaWxhcid9PC9zcGFuPjwvdGQ+CiAgICAgIDwvdHI+YDsKICAgIH0pLmpvaW4oJycpOwogIH0KCiAgZnVuY3Rpb24gbGluZVBvaW50cyh2YWx1ZXMsIHgwLCB4MSwgeTAsIHkxLCBtaW5WYWx1ZSwgbWF4VmFsdWUpIHsKICAgIGlmICghdmFsdWVzLmxlbmd0aCkgcmV0dXJuICcnOwogICAgY29uc3QgbWluID0gTnVtYmVyLmlzRmluaXRlKG1pblZhbHVlKSA/IG1pblZhbHVlIDogTWF0aC5taW4oLi4udmFsdWVzKTsKICAgIGNvbnN0IG1heCA9IE51bWJlci5pc0Zpbml0ZShtYXhWYWx1ZSkgPyBtYXhWYWx1ZSA6IE1hdGgubWF4KC4uLnZhbHVlcyk7CiAgICBjb25zdCBzcGFuID0gTWF0aC5tYXgoMC4wMDAwMDEsIG1heCAtIG1pbik7CiAgICByZXR1cm4gdmFsdWVzLm1hcCgodiwgaSkgPT4gewogICAgICBjb25zdCB4ID0geDAgKyAoKHgxIC0geDApICogaSAvIE1hdGgubWF4KDEsIHZhbHVlcy5sZW5ndGggLSAxKSk7CiAgICAgIGNvbnN0IHkgPSB5MSAtICgodiAtIG1pbikgLyBzcGFuKSAqICh5MSAtIHkwKTsKICAgICAgcmV0dXJuIGAke3gudG9GaXhlZCgyKX0sJHt5LnRvRml4ZWQoMil9YDsKICAgIH0pLmpvaW4oJyAnKTsKICB9CiAgZnVuY3Rpb24gdmFsdWVUb1kodmFsdWUsIHkwLCB5MSwgbWluVmFsdWUsIG1heFZhbHVlKSB7CiAgICBjb25zdCBzcGFuID0gTWF0aC5tYXgoMC4wMDAwMDEsIG1heFZhbHVlIC0gbWluVmFsdWUpOwogICAgcmV0dXJuIHkxIC0gKCh2YWx1ZSAtIG1pblZhbHVlKSAvIHNwYW4pICogKHkxIC0geTApOwogIH0KICBmdW5jdGlvbiBjYWxjQnJlY2hhUGN0KG1lcCwgY2NsKSB7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShtZXApIHx8ICFOdW1iZXIuaXNGaW5pdGUoY2NsKSkgcmV0dXJuIG51bGw7CiAgICBjb25zdCBhdmcgPSAobWVwICsgY2NsKSAvIDI7CiAgICBpZiAoIWF2ZykgcmV0dXJuIG51bGw7CiAgICByZXR1cm4gKE1hdGguYWJzKG1lcCAtIGNjbCkgLyBhdmcpICogMTAwOwogIH0KICBmdW5jdGlvbiBoaWRlVHJlbmRIb3ZlcigpIHsKICAgIGNvbnN0IHRpcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC10b29sdGlwJyk7CiAgICBjb25zdCBsaW5lID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLWhvdmVyLWxpbmUnKTsKICAgIGNvbnN0IG1lcERvdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1ob3Zlci1tZXAnKTsKICAgIGNvbnN0IGNjbERvdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1ob3Zlci1jY2wnKTsKICAgIGlmICh0aXApIHRpcC5zZXRBdHRyaWJ1dGUoJ29wYWNpdHknLCAnMCcpOwogICAgaWYgKGxpbmUpIGxpbmUuc2V0QXR0cmlidXRlKCdvcGFjaXR5JywgJzAnKTsKICAgIGlmIChtZXBEb3QpIG1lcERvdC5zZXRBdHRyaWJ1dGUoJ29wYWNpdHknLCAnMCcpOwogICAgaWYgKGNjbERvdCkgY2NsRG90LnNldEF0dHJpYnV0ZSgnb3BhY2l0eScsICcwJyk7CiAgfQogIGZ1bmN0aW9uIHJlbmRlclRyZW5kSG92ZXIocG9pbnQpIHsKICAgIGNvbnN0IHRpcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC10b29sdGlwJyk7CiAgICBjb25zdCBiZyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC10b29sdGlwLWJnJyk7CiAgICBjb25zdCBsaW5lID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLWhvdmVyLWxpbmUnKTsKICAgIGNvbnN0IG1lcERvdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1ob3Zlci1tZXAnKTsKICAgIGNvbnN0IGNjbERvdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1ob3Zlci1jY2wnKTsKICAgIGlmICghdGlwIHx8ICFiZyB8fCAhbGluZSB8fCAhbWVwRG90IHx8ICFjY2xEb3QgfHwgIXBvaW50KSByZXR1cm47CgogICAgbGluZS5zZXRBdHRyaWJ1dGUoJ3gxJywgcG9pbnQueC50b0ZpeGVkKDIpKTsKICAgIGxpbmUuc2V0QXR0cmlidXRlKCd4MicsIHBvaW50LngudG9GaXhlZCgyKSk7CiAgICBsaW5lLnNldEF0dHJpYnV0ZSgnb3BhY2l0eScsICcxJyk7CiAgICBtZXBEb3Quc2V0QXR0cmlidXRlKCdjeCcsIHBvaW50LngudG9GaXhlZCgyKSk7CiAgICBtZXBEb3Quc2V0QXR0cmlidXRlKCdjeScsIHBvaW50Lm1lcFkudG9GaXhlZCgyKSk7CiAgICBtZXBEb3Quc2V0QXR0cmlidXRlKCdvcGFjaXR5JywgJzEnKTsKICAgIGNjbERvdC5zZXRBdHRyaWJ1dGUoJ2N4JywgcG9pbnQueC50b0ZpeGVkKDIpKTsKICAgIGNjbERvdC5zZXRBdHRyaWJ1dGUoJ2N5JywgcG9pbnQuY2NsWS50b0ZpeGVkKDIpKTsKICAgIGNjbERvdC5zZXRBdHRyaWJ1dGUoJ29wYWNpdHknLCAnMScpOwoKICAgIHNldFRleHQoJ3RyZW5kLXRpcC10aW1lJywgcm93RGF5SG91ckxhYmVsKHBvaW50LmVwb2NoKSk7CiAgICBzZXRUZXh0KCd0cmVuZC10aXAtbWVwJywgYE1FUCAke2Zvcm1hdE1vbmV5KHBvaW50Lm1lcCwgMil9YCk7CiAgICBzZXRUZXh0KCd0cmVuZC10aXAtY2NsJywgYENDTCAke2Zvcm1hdE1vbmV5KHBvaW50LmNjbCwgMil9YCk7CiAgICBzZXRUZXh0KCd0cmVuZC10aXAtZ2FwJywgYEJyZWNoYSAke2Zvcm1hdFBlcmNlbnQocG9pbnQucGN0LCAyKX1gKTsKCiAgICBjb25zdCB0aXBXID0gMTQ4OwogICAgY29uc3QgdGlwSCA9IDU2OwogICAgY29uc3QgdGlwWCA9IE1hdGgubWluKDg0MCAtIHRpcFcsIE1hdGgubWF4KDMwLCBwb2ludC54ICsgMTApKTsKICAgIGNvbnN0IHRpcFkgPSBNYXRoLm1pbigxMDAsIE1hdGgubWF4KDE4LCBNYXRoLm1pbihwb2ludC5tZXBZLCBwb2ludC5jY2xZKSAtIHRpcEggLSA0KSk7CiAgICB0aXAuc2V0QXR0cmlidXRlKCd0cmFuc2Zvcm0nLCBgdHJhbnNsYXRlKCR7dGlwWC50b0ZpeGVkKDIpfSAke3RpcFkudG9GaXhlZCgyKX0pYCk7CiAgICBiZy5zZXRBdHRyaWJ1dGUoJ3dpZHRoJywgU3RyaW5nKHRpcFcpKTsKICAgIGJnLnNldEF0dHJpYnV0ZSgnaGVpZ2h0JywgU3RyaW5nKHRpcEgpKTsKICAgIHRpcC5zZXRBdHRyaWJ1dGUoJ29wYWNpdHknLCAnMScpOwogIH0KICBmdW5jdGlvbiBiaW5kVHJlbmRIb3ZlcigpIHsKICAgIGlmIChzdGF0ZS50cmVuZEhvdmVyQm91bmQpIHJldHVybjsKICAgIGNvbnN0IGNoYXJ0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLWNoYXJ0Jyk7CiAgICBpZiAoIWNoYXJ0KSByZXR1cm47CiAgICBzdGF0ZS50cmVuZEhvdmVyQm91bmQgPSB0cnVlOwoKICAgIGNoYXJ0LmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlbGVhdmUnLCAoKSA9PiBoaWRlVHJlbmRIb3ZlcigpKTsKICAgIGNoYXJ0LmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlbW92ZScsIChldmVudCkgPT4gewogICAgICBpZiAoIXN0YXRlLnRyZW5kUm93cy5sZW5ndGgpIHJldHVybjsKICAgICAgY29uc3QgY3RtID0gY2hhcnQuZ2V0U2NyZWVuQ1RNKCk7CiAgICAgIGlmICghY3RtKSByZXR1cm47CiAgICAgIGNvbnN0IHB0ID0gY2hhcnQuY3JlYXRlU1ZHUG9pbnQoKTsKICAgICAgcHQueCA9IGV2ZW50LmNsaWVudFg7CiAgICAgIHB0LnkgPSBldmVudC5jbGllbnRZOwogICAgICBjb25zdCBsb2NhbCA9IHB0Lm1hdHJpeFRyYW5zZm9ybShjdG0uaW52ZXJzZSgpKTsKICAgICAgY29uc3QgeCA9IE1hdGgubWF4KDMwLCBNYXRoLm1pbig4NDAsIGxvY2FsLngpKTsKICAgICAgbGV0IG5lYXJlc3QgPSBzdGF0ZS50cmVuZFJvd3NbMF07CiAgICAgIGxldCBiZXN0ID0gTWF0aC5hYnMobmVhcmVzdC54IC0geCk7CiAgICAgIGZvciAobGV0IGkgPSAxOyBpIDwgc3RhdGUudHJlbmRSb3dzLmxlbmd0aDsgaSsrKSB7CiAgICAgICAgY29uc3QgZCA9IE1hdGguYWJzKHN0YXRlLnRyZW5kUm93c1tpXS54IC0geCk7CiAgICAgICAgaWYgKGQgPCBiZXN0KSB7CiAgICAgICAgICBiZXN0ID0gZDsKICAgICAgICAgIG5lYXJlc3QgPSBzdGF0ZS50cmVuZFJvd3NbaV07CiAgICAgICAgfQogICAgICB9CiAgICAgIHJlbmRlclRyZW5kSG92ZXIobmVhcmVzdCk7CiAgICB9KTsKICB9CgogIGZ1bmN0aW9uIHJlbmRlclRyZW5kKHBheWxvYWQpIHsKICAgIGNvbnN0IGhpc3RvcnkgPSBkb3duc2FtcGxlUm93cyhmaWx0ZXJIaXN0b3J5Um93cyhleHRyYWN0SGlzdG9yeVJvd3MocGF5bG9hZCksIHN0YXRlLmZpbHRlck1vZGUpLCBUUkVORF9NQVhfUE9JTlRTKTsKICAgIGNvbnN0IG1lcExpbmUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtbWVwLWxpbmUnKTsKICAgIGNvbnN0IGNjbExpbmUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtY2NsLWxpbmUnKTsKICAgIGlmICghbWVwTGluZSB8fCAhY2NsTGluZSkgcmV0dXJuOwogICAgYmluZFRyZW5kSG92ZXIoKTsKICAgIGlmICghaGlzdG9yeS5sZW5ndGgpIHsKICAgICAgbWVwTGluZS5zZXRBdHRyaWJ1dGUoJ3BvaW50cycsICcnKTsKICAgICAgY2NsTGluZS5zZXRBdHRyaWJ1dGUoJ3BvaW50cycsICcnKTsKICAgICAgc3RhdGUudHJlbmRSb3dzID0gW107CiAgICAgIGhpZGVUcmVuZEhvdmVyKCk7CiAgICAgIFsndHJlbmQteS10b3AnLCAndHJlbmQteS1taWQnLCAndHJlbmQteS1sb3cnLCAndHJlbmQteC0xJywgJ3RyZW5kLXgtMicsICd0cmVuZC14LTMnLCAndHJlbmQteC00JywgJ3RyZW5kLXgtNSddLmZvckVhY2goKGlkKSA9PiBzZXRUZXh0KGlkLCAn4oCUJykpOwogICAgICByZXR1cm47CiAgICB9CgogICAgY29uc3Qgcm93cyA9IGhpc3RvcnkKICAgICAgLm1hcCgocikgPT4gKHsKICAgICAgICBlcG9jaDogci5lcG9jaCwKICAgICAgICBtZXA6IHRvTnVtYmVyKHIubWVwKSwKICAgICAgICBjY2w6IHRvTnVtYmVyKHIuY2NsKSwKICAgICAgICBwY3Q6IHRvTnVtYmVyKHIucGN0X2RpZmYpCiAgICAgIH0pKQogICAgICAuZmlsdGVyKChyKSA9PiByLm1lcCAhPSBudWxsICYmIHIuY2NsICE9IG51bGwpOwogICAgaWYgKCFyb3dzLmxlbmd0aCkgcmV0dXJuOwoKICAgIGNvbnN0IG1lcFZhbHMgPSByb3dzLm1hcCgocikgPT4gci5tZXApOwogICAgY29uc3QgY2NsVmFscyA9IHJvd3MubWFwKChyKSA9PiByLmNjbCk7CgogICAgLy8gRXNjYWxhIGNvbXBhcnRpZGEgcGFyYSBNRVAgeSBDQ0w6IGNvbXBhcmFjacOzbiB2aXN1YWwgZmllbC4KICAgIGNvbnN0IGFsbFByaWNlVmFscyA9IG1lcFZhbHMuY29uY2F0KGNjbFZhbHMpOwogICAgY29uc3QgcmF3TWluID0gTWF0aC5taW4oLi4uYWxsUHJpY2VWYWxzKTsKICAgIGNvbnN0IHJhd01heCA9IE1hdGgubWF4KC4uLmFsbFByaWNlVmFscyk7CiAgICBjb25zdCBwcmljZVBhZCA9IE1hdGgubWF4KDEsIChyYXdNYXggLSByYXdNaW4pICogMC4wOCk7CiAgICBjb25zdCBwcmljZU1pbiA9IHJhd01pbiAtIHByaWNlUGFkOwogICAgY29uc3QgcHJpY2VNYXggPSByYXdNYXggKyBwcmljZVBhZDsKCiAgICBtZXBMaW5lLnNldEF0dHJpYnV0ZSgncG9pbnRzJywgbGluZVBvaW50cyhtZXBWYWxzLCAzMCwgODQwLCAyNSwgMTMwLCBwcmljZU1pbiwgcHJpY2VNYXgpKTsKICAgIGNjbExpbmUuc2V0QXR0cmlidXRlKCdwb2ludHMnLCBsaW5lUG9pbnRzKGNjbFZhbHMsIDMwLCA4NDAsIDI1LCAxMzAsIHByaWNlTWluLCBwcmljZU1heCkpOwogICAgc3RhdGUudHJlbmRSb3dzID0gcm93cy5tYXAoKHIsIGkpID0+IHsKICAgICAgY29uc3QgeCA9IDMwICsgKCg4NDAgLSAzMCkgKiBpIC8gTWF0aC5tYXgoMSwgcm93cy5sZW5ndGggLSAxKSk7CiAgICAgIHJldHVybiB7CiAgICAgICAgZXBvY2g6IHIuZXBvY2gsCiAgICAgICAgbWVwOiByLm1lcCwKICAgICAgICBjY2w6IHIuY2NsLAogICAgICAgIHBjdDogY2FsY0JyZWNoYVBjdChyLm1lcCwgci5jY2wpLAogICAgICAgIHgsCiAgICAgICAgbWVwWTogdmFsdWVUb1koci5tZXAsIDI1LCAxMzAsIHByaWNlTWluLCBwcmljZU1heCksCiAgICAgICAgY2NsWTogdmFsdWVUb1koci5jY2wsIDI1LCAxMzAsIHByaWNlTWluLCBwcmljZU1heCkKICAgICAgfTsKICAgIH0pOwogICAgaGlkZVRyZW5kSG92ZXIoKTsKCiAgICBjb25zdCBtaWQgPSAocHJpY2VNaW4gKyBwcmljZU1heCkgLyAyOwogICAgc2V0VGV4dCgndHJlbmQteS10b3AnLCAocHJpY2VNYXggLyAxMDAwKS50b0ZpeGVkKDMpKTsKICAgIHNldFRleHQoJ3RyZW5kLXktbWlkJywgKG1pZCAvIDEwMDApLnRvRml4ZWQoMykpOwogICAgc2V0VGV4dCgndHJlbmQteS1sb3cnLCAocHJpY2VNaW4gLyAxMDAwKS50b0ZpeGVkKDMpKTsKCiAgICBjb25zdCBpZHggPSBbMCwgMC4yNSwgMC41LCAwLjc1LCAxXS5tYXAoKHApID0+IE1hdGgubWluKHJvd3MubGVuZ3RoIC0gMSwgTWF0aC5mbG9vcigocm93cy5sZW5ndGggLSAxKSAqIHApKSk7CiAgICBjb25zdCBsYWJzID0gaWR4Lm1hcCgoaSkgPT4gcm93RGF5SG91ckxhYmVsKHJvd3NbaV0/LmVwb2NoKSk7CiAgICBzZXRUZXh0KCd0cmVuZC14LTEnLCBsYWJzWzBdIHx8ICfigJQnKTsKICAgIHNldFRleHQoJ3RyZW5kLXgtMicsIGxhYnNbMV0gfHwgJ+KAlCcpOwogICAgc2V0VGV4dCgndHJlbmQteC0zJywgbGFic1syXSB8fCAn4oCUJyk7CiAgICBzZXRUZXh0KCd0cmVuZC14LTQnLCBsYWJzWzNdIHx8ICfigJQnKTsKICAgIHNldFRleHQoJ3RyZW5kLXgtNScsIGxhYnNbNF0gfHwgJ+KAlCcpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyRmNpUmVudGFGaWphKHBheWxvYWQpIHsKICAgIGNvbnN0IHJvd3NFbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmY2ktcm93cycpOwogICAgY29uc3QgZW1wdHlFbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmY2ktZW1wdHknKTsKICAgIGlmICghcm93c0VsIHx8ICFlbXB0eUVsKSByZXR1cm47CiAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA+IDApIHsKICAgICAgY29uc3Qgcm93cyA9IG5vcm1hbGl6ZUZjaVJvd3MocGF5bG9hZCkKICAgICAgICAubWFwKChpdGVtKSA9PiB7CiAgICAgICAgICBjb25zdCBmb25kbyA9IFN0cmluZyhpdGVtPy5mb25kbyB8fCBpdGVtPy5ub21icmUgfHwgaXRlbT8uZmNpIHx8ICcnKS50cmltKCk7CiAgICAgICAgICBjb25zdCBmZWNoYSA9IFN0cmluZyhpdGVtPy5mZWNoYSB8fCAnJykudHJpbSgpOwogICAgICAgICAgY29uc3QgdmNwID0gdG9OdW1iZXIoaXRlbT8udmNwKTsKICAgICAgICAgIGNvbnN0IGNjcCA9IHRvTnVtYmVyKGl0ZW0/LmNjcCk7CiAgICAgICAgICBjb25zdCBwYXRyaW1vbmlvID0gdG9OdW1iZXIoaXRlbT8ucGF0cmltb25pbyk7CiAgICAgICAgICBjb25zdCBob3Jpem9udGUgPSBTdHJpbmcoaXRlbT8uaG9yaXpvbnRlIHx8ICcnKS50cmltKCk7CiAgICAgICAgICByZXR1cm4geyBmb25kbywgZmVjaGEsIHZjcCwgY2NwLCBwYXRyaW1vbmlvLCBob3Jpem9udGUgfTsKICAgICAgICB9KQogICAgICAgIC5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0uZm9uZG8gJiYgKGl0ZW0udmNwICE9PSBudWxsIHx8IGl0ZW0uZmVjaGEpKTsKICAgICAgc3RhdGUuZmNpUm93cyA9IHJvd3Muc2xpY2UoKS5zb3J0KChhLCBiKSA9PiAoYi5wYXRyaW1vbmlvID8/IC1JbmZpbml0eSkgLSAoYS5wYXRyaW1vbmlvID8/IC1JbmZpbml0eSkpOwogICAgICBzdGF0ZS5mY2lQYWdlID0gMTsKICAgIH0KCiAgICBjb25zdCBxdWVyeSA9IHN0YXRlLmZjaVF1ZXJ5LnRyaW0oKS50b0xvd2VyQ2FzZSgpOwogICAgY29uc3QgZmlsdGVyZWQgPSBxdWVyeQogICAgICA/IHN0YXRlLmZjaVJvd3MuZmlsdGVyKChyb3cpID0+IHJvdy5mb25kby50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHF1ZXJ5KSkKICAgICAgOiBzdGF0ZS5mY2lSb3dzLnNsaWNlKCk7CgogICAgY29uc3QgdG90YWxQYWdlcyA9IE1hdGgubWF4KDEsIE1hdGguY2VpbChmaWx0ZXJlZC5sZW5ndGggLyBGQ0lfUEFHRV9TSVpFKSk7CiAgICBzdGF0ZS5mY2lQYWdlID0gTWF0aC5taW4oTWF0aC5tYXgoMSwgc3RhdGUuZmNpUGFnZSksIHRvdGFsUGFnZXMpOwogICAgY29uc3QgZnJvbSA9IChzdGF0ZS5mY2lQYWdlIC0gMSkgKiBGQ0lfUEFHRV9TSVpFOwogICAgY29uc3QgcGFnZVJvd3MgPSBmaWx0ZXJlZC5zbGljZShmcm9tLCBmcm9tICsgRkNJX1BBR0VfU0laRSk7CgogICAgY29uc3QgZGF0ZUVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZjaS1sYXN0LWRhdGUnKTsKICAgIGNvbnN0IGZpcnN0RGF0ZSA9IGZpbHRlcmVkLmZpbmQoKHJvdykgPT4gcm93LmZlY2hhKT8uZmVjaGEgfHwgJ+KAlCc7CiAgICBpZiAoZGF0ZUVsKSBkYXRlRWwudGV4dENvbnRlbnQgPSBgRmVjaGE6ICR7Zmlyc3REYXRlfWA7CiAgICBzZXRUZXh0KCdmY2ktcGFnZS1pbmZvJywgYCR7c3RhdGUuZmNpUGFnZX0gLyAke3RvdGFsUGFnZXN9YCk7CiAgICBjb25zdCBwcmV2QnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZjaS1wcmV2Jyk7CiAgICBjb25zdCBuZXh0QnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZjaS1uZXh0Jyk7CiAgICBpZiAocHJldkJ0bikgcHJldkJ0bi5kaXNhYmxlZCA9IHN0YXRlLmZjaVBhZ2UgPD0gMTsKICAgIGlmIChuZXh0QnRuKSBuZXh0QnRuLmRpc2FibGVkID0gc3RhdGUuZmNpUGFnZSA+PSB0b3RhbFBhZ2VzOwoKICAgIGlmICghcGFnZVJvd3MubGVuZ3RoKSB7CiAgICAgIHJvd3NFbC5pbm5lckhUTUwgPSAnJzsKICAgICAgaWYgKHF1ZXJ5KSBlbXB0eUVsLnRleHRDb250ZW50ID0gJ05vIGhheSByZXN1bHRhZG9zIHBhcmEgbGEgYsO6c3F1ZWRhIGluZGljYWRhLic7CiAgICAgIGVsc2UgZW1wdHlFbC50ZXh0Q29udGVudCA9ICdObyBoYXkgZGF0b3MgZGUgcmVudGEgZmlqYSBkaXNwb25pYmxlcyBlbiBlc3RlIG1vbWVudG8uJzsKICAgICAgZW1wdHlFbC5zdHlsZS5kaXNwbGF5ID0gJ2Jsb2NrJzsKICAgICAgcmV0dXJuOwogICAgfQoKICAgIGVtcHR5RWwuc3R5bGUuZGlzcGxheSA9ICdub25lJzsKICAgIHJvd3NFbC5pbm5lckhUTUwgPSBwYWdlUm93cy5tYXAoKHJvdykgPT4gYAogICAgICA8dHI+CiAgICAgICAgPHRkPiR7ZXNjYXBlSHRtbChyb3cuZm9uZG8pfTwvdGQ+CiAgICAgICAgPHRkPiR7Zm9ybWF0Q29tcGFjdE1vbmV5KHJvdy52Y3AsIDYpfTwvdGQ+CiAgICAgICAgPHRkPiR7Zm9ybWF0Q29tcGFjdE1vbmV5KHJvdy5jY3AsIDYpfTwvdGQ+CiAgICAgICAgPHRkPiR7Zm9ybWF0Q29tcGFjdE1vbmV5KHJvdy5wYXRyaW1vbmlvLCAyKX08L3RkPgogICAgICAgIDx0ZD4ke2VzY2FwZUh0bWwocm93Lmhvcml6b250ZSB8fCAn4oCUJyl9PC90ZD4KICAgICAgPC90cj4KICAgIGApLmpvaW4oJycpOwogIH0KCiAgLy8gNCkgRnVuY2nDs24gY2VudHJhbCBmZXRjaEFsbCgpCiAgYXN5bmMgZnVuY3Rpb24gZmV0Y2hKc29uKHVybCkgewogICAgY29uc3QgY3RybCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTsKICAgIGNvbnN0IHRpbWVvdXQgPSBzZXRUaW1lb3V0KCgpID0+IGN0cmwuYWJvcnQoKSwgMTIwMDApOwogICAgdHJ5IHsKICAgICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2godXJsLCB7IGNhY2hlOiAnbm8tc3RvcmUnLCBzaWduYWw6IGN0cmwuc2lnbmFsIH0pOwogICAgICBpZiAoIXJlcy5vaykgdGhyb3cgbmV3IEVycm9yKGBIVFRQICR7cmVzLnN0YXR1c31gKTsKICAgICAgcmV0dXJuIGF3YWl0IHJlcy5qc29uKCk7CiAgICB9IGZpbmFsbHkgewogICAgICBjbGVhclRpbWVvdXQodGltZW91dCk7CiAgICB9CiAgfQoKICBhc3luYyBmdW5jdGlvbiBmZXRjaEFsbChvcHRpb25zID0ge30pIHsKICAgIGlmIChzdGF0ZS5pc0ZldGNoaW5nKSByZXR1cm47CiAgICBzdGF0ZS5pc0ZldGNoaW5nID0gdHJ1ZTsKICAgIHNldExvYWRpbmcoTlVNRVJJQ19JRFMsIHRydWUpOwogICAgc2V0RnJlc2hCYWRnZSgnQWN0dWFsaXphbmRv4oCmJywgJ2ZldGNoaW5nJyk7CiAgICBzZXRFcnJvckJhbm5lcihmYWxzZSk7CiAgICB0cnkgewogICAgICBjb25zdCB0YXNrcyA9IFsKICAgICAgICBbJ21lcENjbCcsIEVORFBPSU5UUy5tZXBDY2xdLAogICAgICAgIFsnZmNpUmVudGFGaWphJywgRU5EUE9JTlRTLmZjaVJlbnRhRmlqYV0KICAgICAgXTsKCiAgICAgIGNvbnN0IHNldHRsZWQgPSBhd2FpdCBQcm9taXNlLmFsbFNldHRsZWQodGFza3MubWFwKGFzeW5jIChbbmFtZSwgdXJsXSkgPT4gewogICAgICAgIHRyeSB7CiAgICAgICAgICBjb25zdCBkYXRhID0gYXdhaXQgZmV0Y2hKc29uKHVybCk7CiAgICAgICAgICByZXR1cm4geyBuYW1lLCBkYXRhIH07CiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHsKICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYFtSYWRhck1FUF0gZXJyb3IgZW4gJHtuYW1lfWAsIGVycm9yKTsKICAgICAgICAgIHRocm93IHsgbmFtZSwgZXJyb3IgfTsKICAgICAgICB9CiAgICAgIH0pKTsKCiAgICAgIGNvbnN0IGJhZyA9IHsgdGltZXN0YW1wOiBEYXRlLm5vdygpLCBtZXBDY2w6IG51bGwsIGZjaVJlbnRhRmlqYTogbnVsbCB9OwogICAgICBjb25zdCBmYWlsZWQgPSBbXTsKICAgICAgc2V0dGxlZC5mb3JFYWNoKChyLCBpZHgpID0+IHsKICAgICAgICBjb25zdCBuYW1lID0gdGFza3NbaWR4XVswXTsKICAgICAgICBpZiAoci5zdGF0dXMgPT09ICdmdWxmaWxsZWQnKSBiYWdbbmFtZV0gPSByLnZhbHVlLmRhdGE7CiAgICAgICAgZWxzZSBmYWlsZWQucHVzaChuYW1lKTsKICAgICAgfSk7CgogICAgICByZW5kZXJNZXBDY2woYmFnLm1lcENjbCk7CiAgICAgIHJlbmRlckZjaVJlbnRhRmlqYShiYWcuZmNpUmVudGFGaWphKTsKICAgICAgc3RhdGUubGFzdE1lcFBheWxvYWQgPSBiYWcubWVwQ2NsOwogICAgICByZW5kZXJNZXRyaWNzMjRoKGJhZy5tZXBDY2wpOwogICAgICByZW5kZXJUcmVuZChiYWcubWVwQ2NsKTsKICAgICAgcmVuZGVySGlzdG9yeShiYWcubWVwQ2NsKTsKICAgICAgY29uc3QgbWVwUm9vdCA9IGV4dHJhY3RSb290KGJhZy5tZXBDY2wpOwogICAgICBjb25zdCB1cGRhdGVkQXJ0ID0gdHlwZW9mIG1lcFJvb3Q/LnVwZGF0ZWRBdEh1bWFuQXJ0ID09PSAnc3RyaW5nJyA/IG1lcFJvb3QudXBkYXRlZEF0SHVtYW5BcnQgOiBudWxsOwogICAgICBjb25zdCBzb3VyY2VUc01zID0gdG9OdW1iZXIobWVwUm9vdD8uc291cmNlU3RhdHVzPy5sYXRlc3RTb3VyY2VUc01zKQogICAgICAgID8/IHRvTnVtYmVyKG1lcFJvb3Q/LmN1cnJlbnQ/Lm1lcFRzTXMpCiAgICAgICAgPz8gdG9OdW1iZXIobWVwUm9vdD8uY3VycmVudD8uY2NsVHNNcykKICAgICAgICA/PyBudWxsOwogICAgICBzdGF0ZS5zb3VyY2VUc01zID0gc291cmNlVHNNczsKICAgICAgc2V0VGV4dCgnbGFzdC1ydW4tdGltZScsIHVwZGF0ZWRBcnQgfHwgZm10QXJnVGltZVNlYy5mb3JtYXQobmV3IERhdGUoKSkpOwoKICAgICAgY29uc3Qgc3VjY2Vzc0NvdW50ID0gdGFza3MubGVuZ3RoIC0gZmFpbGVkLmxlbmd0aDsKICAgICAgaWYgKHN1Y2Nlc3NDb3VudCA+IDApIHsKICAgICAgICBzdGF0ZS5sYXN0U3VjY2Vzc0F0ID0gRGF0ZS5ub3coKTsKICAgICAgICBzdGF0ZS5yZXRyeUluZGV4ID0gMDsKICAgICAgICBpZiAoc3RhdGUucmV0cnlUaW1lcikgY2xlYXJUaW1lb3V0KHN0YXRlLnJldHJ5VGltZXIpOwogICAgICAgIHNhdmVDYWNoZShiYWcpOwogICAgICAgIGNvbnN0IGFnZUxhYmVsID0gc291cmNlVHNNcyAhPSBudWxsID8gZm9ybWF0U291cmNlQWdlTGFiZWwoc291cmNlVHNNcykgOiBudWxsOwogICAgICAgIGNvbnN0IGJhZGdlQmFzZSA9IGFnZUxhYmVsID8gYMOabHRpbWEgYWN0dWFsaXphY2nDs24gaGFjZTogJHthZ2VMYWJlbH1gIDogYEFjdHVhbGl6YWRvIMK3ICR7Zm10QXJnVGltZS5mb3JtYXQobmV3IERhdGUoKSl9YDsKICAgICAgICBpZiAoZmFpbGVkLmxlbmd0aCkgc2V0RnJlc2hCYWRnZShgQWN0dWFsaXphY2nDs24gcGFyY2lhbCDCtyAke2JhZGdlQmFzZX1gLCAnaWRsZScpOwogICAgICAgIGVsc2Ugc2V0RnJlc2hCYWRnZShiYWRnZUJhc2UsICdpZGxlJyk7CiAgICAgICAgcmVmcmVzaEZyZXNoQmFkZ2VGcm9tU291cmNlKCk7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgY29uc3QgYXR0ZW1wdCA9IHN0YXRlLnJldHJ5SW5kZXggKyAxOwogICAgICAgIGlmIChzdGF0ZS5yZXRyeUluZGV4IDwgUkVUUllfREVMQVlTLmxlbmd0aCkgewogICAgICAgICAgY29uc3QgZGVsYXkgPSBSRVRSWV9ERUxBWVNbc3RhdGUucmV0cnlJbmRleF07CiAgICAgICAgICBzdGF0ZS5yZXRyeUluZGV4ICs9IDE7CiAgICAgICAgICBzZXRGcmVzaEJhZGdlKGBFcnJvciDCtyBSZWludGVudG8gZW4gJHtNYXRoLnJvdW5kKGRlbGF5IC8gMTAwMCl9c2AsICdlcnJvcicpOwogICAgICAgICAgaWYgKHN0YXRlLnJldHJ5VGltZXIpIGNsZWFyVGltZW91dChzdGF0ZS5yZXRyeVRpbWVyKTsKICAgICAgICAgIHN0YXRlLnJldHJ5VGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IGZldGNoQWxsKHsgbWFudWFsOiB0cnVlIH0pLCBkZWxheSk7CiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgIHNldEZyZXNoQmFkZ2UoJ0Vycm9yIMK3IFJlaW50ZW50YXInLCAnZXJyb3InKTsKICAgICAgICAgIHNldEVycm9yQmFubmVyKHRydWUsICdFcnJvciBhbCBhY3R1YWxpemFyIMK3IFJlaW50ZW50YXInKTsKICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYFtSYWRhck1FUF0gc2UgYWdvdGFyb24gcmV0cmllcyAoJHthdHRlbXB0fSBpbnRlbnRvcylgKTsKICAgICAgICAgIGlmICh3aW5kb3cuc2NoZWR1bGVyKSB3aW5kb3cuc2NoZWR1bGVyLnN0b3AoKTsKICAgICAgICB9CiAgICAgIH0KICAgIH0gZmluYWxseSB7CiAgICAgIHNldExvYWRpbmcoTlVNRVJJQ19JRFMsIGZhbHNlKTsKICAgICAgc3RhdGUuaXNGZXRjaGluZyA9IGZhbHNlOwogICAgfQogIH0KCiAgLy8gNSkgQ2xhc2UgTWFya2V0U2NoZWR1bGVyCiAgY2xhc3MgTWFya2V0U2NoZWR1bGVyIHsKICAgIGNvbnN0cnVjdG9yKGZldGNoRm4sIGludGVydmFsTXMgPSAzMDAwMDApIHsKICAgICAgdGhpcy5mZXRjaEZuID0gZmV0Y2hGbjsKICAgICAgdGhpcy5pbnRlcnZhbE1zID0gaW50ZXJ2YWxNczsKICAgICAgdGhpcy50aW1lciA9IG51bGw7CiAgICAgIHRoaXMud2FpdFRpbWVyID0gbnVsbDsKICAgICAgdGhpcy5jb3VudGRvd25UaW1lciA9IG51bGw7CiAgICAgIHRoaXMubmV4dFJ1bkF0ID0gbnVsbDsKICAgICAgdGhpcy5ydW5uaW5nID0gZmFsc2U7CiAgICAgIHRoaXMucGF1c2VkID0gZmFsc2U7CiAgICB9CgogICAgc3RhcnQoKSB7CiAgICAgIGlmICh0aGlzLnJ1bm5pbmcpIHJldHVybjsKICAgICAgdGhpcy5ydW5uaW5nID0gdHJ1ZTsKICAgICAgdGhpcy5wYXVzZWQgPSBmYWxzZTsKICAgICAgaWYgKHRoaXMuaXNNYXJrZXRPcGVuKCkpIHsKICAgICAgICBzZXRNYXJrZXRUYWcodHJ1ZSk7CiAgICAgICAgdGhpcy5fc2NoZWR1bGUodGhpcy5pbnRlcnZhbE1zKTsKICAgICAgfSBlbHNlIHsKICAgICAgICBzZXRNYXJrZXRUYWcoZmFsc2UpOwogICAgICAgIHRoaXMuX3dhaXRGb3JPcGVuKCk7CiAgICAgIH0KICAgICAgdGhpcy5fc3RhcnRDb3VudGRvd24oKTsKICAgIH0KCiAgICBwYXVzZSgpIHsKICAgICAgdGhpcy5wYXVzZWQgPSB0cnVlOwogICAgICBjbGVhclRpbWVvdXQodGhpcy50aW1lcik7CiAgICAgIGNsZWFyVGltZW91dCh0aGlzLndhaXRUaW1lcik7CiAgICAgIHRoaXMudGltZXIgPSBudWxsOwogICAgICB0aGlzLndhaXRUaW1lciA9IG51bGw7CiAgICAgIHRoaXMuX3N0b3BDb3VudGRvd24oKTsKICAgICAgY29uc3QgY291bnRkb3duID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NvdW50ZG93bi10ZXh0Jyk7CiAgICAgIGlmIChjb3VudGRvd24pIGNvdW50ZG93bi50ZXh0Q29udGVudCA9ICdBY3R1YWxpemFjacOzbiBwYXVzYWRhJzsKICAgIH0KCiAgICByZXN1bWUoKSB7CiAgICAgIGlmICghdGhpcy5ydW5uaW5nKSB0aGlzLnJ1bm5pbmcgPSB0cnVlOwogICAgICB0aGlzLnBhdXNlZCA9IGZhbHNlOwogICAgICBjb25zdCBjb250aW51ZVJlc3VtZSA9ICgpID0+IHsKICAgICAgICBpZiAodGhpcy5pc01hcmtldE9wZW4oKSkgewogICAgICAgICAgc2V0TWFya2V0VGFnKHRydWUpOwogICAgICAgICAgdGhpcy5fc2NoZWR1bGUodGhpcy5pbnRlcnZhbE1zKTsKICAgICAgICB9IGVsc2UgewogICAgICAgICAgc2V0TWFya2V0VGFnKGZhbHNlKTsKICAgICAgICAgIHRoaXMuX3dhaXRGb3JPcGVuKCk7CiAgICAgICAgfQogICAgICAgIHRoaXMuX3N0YXJ0Q291bnRkb3duKCk7CiAgICAgIH07CiAgICAgIGlmIChEYXRlLm5vdygpIC0gc3RhdGUubGFzdFN1Y2Nlc3NBdCA+IHRoaXMuaW50ZXJ2YWxNcykgewogICAgICAgIFByb21pc2UucmVzb2x2ZSh0aGlzLmZldGNoRm4oeyBtYW51YWw6IHRydWUgfSkpLmZpbmFsbHkoY29udGludWVSZXN1bWUpOwogICAgICB9IGVsc2UgewogICAgICAgIGNvbnRpbnVlUmVzdW1lKCk7CiAgICAgIH0KICAgIH0KCiAgICBzdG9wKCkgewogICAgICB0aGlzLnJ1bm5pbmcgPSBmYWxzZTsKICAgICAgdGhpcy5wYXVzZWQgPSBmYWxzZTsKICAgICAgY2xlYXJUaW1lb3V0KHRoaXMudGltZXIpOwogICAgICBjbGVhclRpbWVvdXQodGhpcy53YWl0VGltZXIpOwogICAgICB0aGlzLnRpbWVyID0gbnVsbDsKICAgICAgdGhpcy53YWl0VGltZXIgPSBudWxsOwogICAgICB0aGlzLm5leHRSdW5BdCA9IG51bGw7CiAgICAgIHRoaXMuX3N0b3BDb3VudGRvd24oKTsKICAgIH0KCiAgICBpc01hcmtldE9wZW4oKSB7CiAgICAgIGNvbnN0IHAgPSBnZXRBcmdOb3dQYXJ0cygpOwogICAgICBjb25zdCBidXNpbmVzc0RheSA9IHAud2Vla2RheSA+PSAxICYmIHAud2Vla2RheSA8PSA1OwogICAgICBjb25zdCBzZWNvbmRzID0gcC5ob3VyICogMzYwMCArIHAubWludXRlICogNjAgKyBwLnNlY29uZDsKICAgICAgY29uc3QgZnJvbSA9IDEwICogMzYwMCArIDMwICogNjA7CiAgICAgIGNvbnN0IHRvID0gMTggKiAzNjAwOwogICAgICByZXR1cm4gYnVzaW5lc3NEYXkgJiYgc2Vjb25kcyA+PSBmcm9tICYmIHNlY29uZHMgPCB0bzsKICAgIH0KCiAgICBnZXROZXh0UnVuVGltZSgpIHsKICAgICAgcmV0dXJuIHRoaXMubmV4dFJ1bkF0ID8gbmV3IERhdGUodGhpcy5uZXh0UnVuQXQpIDogbnVsbDsKICAgIH0KCiAgICBfc2NoZWR1bGUoZGVsYXlNcykgewogICAgICBpZiAoIXRoaXMucnVubmluZyB8fCB0aGlzLnBhdXNlZCkgcmV0dXJuOwogICAgICBjbGVhclRpbWVvdXQodGhpcy50aW1lcik7CiAgICAgIHRoaXMubmV4dFJ1bkF0ID0gRGF0ZS5ub3coKSArIGRlbGF5TXM7CiAgICAgIHRoaXMudGltZXIgPSBzZXRUaW1lb3V0KGFzeW5jICgpID0+IHsKICAgICAgICBpZiAoIXRoaXMucnVubmluZyB8fCB0aGlzLnBhdXNlZCkgcmV0dXJuOwogICAgICAgIGlmICghdGhpcy5pc01hcmtldE9wZW4oKSkgewogICAgICAgICAgc2V0TWFya2V0VGFnKGZhbHNlKTsKICAgICAgICAgIHRoaXMuX3dhaXRGb3JPcGVuKCk7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQogICAgICAgIHNldE1hcmtldFRhZyh0cnVlKTsKICAgICAgICBhd2FpdCB0aGlzLmZldGNoRm4oKTsKICAgICAgICB0aGlzLl9zY2hlZHVsZSh0aGlzLmludGVydmFsTXMpOwogICAgICB9LCBkZWxheU1zKTsKICAgIH0KCiAgICBfd2FpdEZvck9wZW4oKSB7CiAgICAgIGlmICghdGhpcy5ydW5uaW5nIHx8IHRoaXMucGF1c2VkKSByZXR1cm47CiAgICAgIGNsZWFyVGltZW91dCh0aGlzLndhaXRUaW1lcik7CiAgICAgIHRoaXMubmV4dFJ1bkF0ID0gRGF0ZS5ub3coKSArIDYwMDAwOwogICAgICB0aGlzLndhaXRUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gewogICAgICAgIGlmICghdGhpcy5ydW5uaW5nIHx8IHRoaXMucGF1c2VkKSByZXR1cm47CiAgICAgICAgaWYgKHRoaXMuaXNNYXJrZXRPcGVuKCkpIHsKICAgICAgICAgIHNldE1hcmtldFRhZyh0cnVlKTsKICAgICAgICAgIHRoaXMuZmV0Y2hGbih7IG1hbnVhbDogdHJ1ZSB9KTsKICAgICAgICAgIHRoaXMuX3NjaGVkdWxlKHRoaXMuaW50ZXJ2YWxNcyk7CiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgIHNldE1hcmtldFRhZyhmYWxzZSk7CiAgICAgICAgICB0aGlzLl93YWl0Rm9yT3BlbigpOwogICAgICAgIH0KICAgICAgfSwgNjAwMDApOwogICAgfQoKICAgIF9zdGFydENvdW50ZG93bigpIHsKICAgICAgdGhpcy5fc3RvcENvdW50ZG93bigpOwogICAgICB0aGlzLmNvdW50ZG93blRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4gewogICAgICAgIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NvdW50ZG93bi10ZXh0Jyk7CiAgICAgICAgaWYgKCFlbCB8fCB0aGlzLnBhdXNlZCkgcmV0dXJuOwogICAgICAgIGNvbnN0IG5leHQgPSB0aGlzLmdldE5leHRSdW5UaW1lKCk7CiAgICAgICAgaWYgKCFuZXh0KSB7CiAgICAgICAgICBlbC50ZXh0Q29udGVudCA9IHRoaXMuaXNNYXJrZXRPcGVuKCkgPyAnUHLDs3hpbWEgYWN0dWFsaXphY2nDs24gZW4g4oCUJyA6ICdNZXJjYWRvIGNlcnJhZG8nOwogICAgICAgICAgcmV0dXJuOwogICAgICAgIH0KICAgICAgICBjb25zdCBkaWZmID0gTWF0aC5tYXgoMCwgbmV4dC5nZXRUaW1lKCkgLSBEYXRlLm5vdygpKTsKICAgICAgICBjb25zdCBtID0gTWF0aC5mbG9vcihkaWZmIC8gNjAwMDApOwogICAgICAgIGNvbnN0IHMgPSBNYXRoLmZsb29yKChkaWZmICUgNjAwMDApIC8gMTAwMCk7CiAgICAgICAgaWYgKHRoaXMuaXNNYXJrZXRPcGVuKCkpIGVsLnRleHRDb250ZW50ID0gYFByw7N4aW1hIGFjdHVhbGl6YWNpw7NuIGVuICR7bX06JHtTdHJpbmcocykucGFkU3RhcnQoMiwgJzAnKX1gOwogICAgICAgIGVsc2UgZWwudGV4dENvbnRlbnQgPSAnTWVyY2FkbyBjZXJyYWRvJzsKICAgICAgfSwgMTAwMCk7CiAgICB9CgogICAgX3N0b3BDb3VudGRvd24oKSB7CiAgICAgIGNsZWFySW50ZXJ2YWwodGhpcy5jb3VudGRvd25UaW1lcik7CiAgICAgIHRoaXMuY291bnRkb3duVGltZXIgPSBudWxsOwogICAgfQogIH0KCiAgLy8gNikgTMOzZ2ljYSBkZSBjYWNow6kKICBmdW5jdGlvbiBzYXZlQ2FjaGUoZGF0YSkgewogICAgdHJ5IHsKICAgICAgc2Vzc2lvblN0b3JhZ2Uuc2V0SXRlbShDQUNIRV9LRVksIEpTT04uc3RyaW5naWZ5KHsKICAgICAgICB0aW1lc3RhbXA6IERhdGUubm93KCksCiAgICAgICAgbWVwQ2NsOiBkYXRhLm1lcENjbCwKICAgICAgICBmY2lSZW50YUZpamE6IGRhdGEuZmNpUmVudGFGaWphCiAgICAgIH0pKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgY29uc29sZS5lcnJvcignW1JhZGFyTUVQXSBubyBzZSBwdWRvIGd1YXJkYXIgY2FjaGUnLCBlKTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIGxvYWRDYWNoZSgpIHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHJhdyA9IHNlc3Npb25TdG9yYWdlLmdldEl0ZW0oQ0FDSEVfS0VZKTsKICAgICAgaWYgKCFyYXcpIHJldHVybiBudWxsOwogICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdyk7CiAgICAgIGlmICghcGFyc2VkLnRpbWVzdGFtcCB8fCBEYXRlLm5vdygpIC0gcGFyc2VkLnRpbWVzdGFtcCA+IENBQ0hFX1RUTF9NUykgcmV0dXJuIG51bGw7CiAgICAgIHJldHVybiBwYXJzZWQ7CiAgICB9IGNhdGNoIChlKSB7CiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tSYWRhck1FUF0gY2FjaGUgaW52w6FsaWRhJywgZSk7CiAgICAgIHJldHVybiBudWxsOwogICAgfQogIH0KCiAgLy8gNykgSW5pY2lhbGl6YWNpw7NuCiAgc3RhcnRGcmVzaFRpY2tlcigpOwogIGZ1bmN0aW9uIHRvZ2dsZURyYXdlcigpIHsKICAgIGNvbnN0IGRyYXdlciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdkcmF3ZXInKTsKICAgIGNvbnN0IHdyYXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYm9keVdyYXAnKTsKICAgIGNvbnN0IGJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdidG5UYXNhcycpOwogICAgY29uc3Qgb3ZsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ292ZXJsYXknKTsKICAgIGNvbnN0IGlzT3BlbiA9IGRyYXdlci5jbGFzc0xpc3QuY29udGFpbnMoJ29wZW4nKTsKICAgIGRyYXdlci5jbGFzc0xpc3QudG9nZ2xlKCdvcGVuJywgIWlzT3Blbik7CiAgICB3cmFwLmNsYXNzTGlzdC50b2dnbGUoJ2RyYXdlci1vcGVuJywgIWlzT3Blbik7CiAgICBidG4uY2xhc3NMaXN0LnRvZ2dsZSgnYWN0aXZlJywgIWlzT3Blbik7CiAgICBvdmwuY2xhc3NMaXN0LnRvZ2dsZSgnc2hvdycsICFpc09wZW4pOwogIH0KCiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnBpbGxbZGF0YS1maWx0ZXJdJykuZm9yRWFjaCgocCkgPT4gewogICAgcC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IGFwcGx5RmlsdGVyKHAuZGF0YXNldC5maWx0ZXIpKTsKICB9KTsKICBjb25zdCBjc3ZCdG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYnRuLWRvd25sb2FkLWNzdicpOwogIGlmIChjc3ZCdG4pIGNzdkJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGRvd25sb2FkSGlzdG9yeUNzdik7CiAgY29uc3QgZmNpU2VhcmNoID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZjaS1zZWFyY2gnKTsKICBpZiAoZmNpU2VhcmNoKSB7CiAgICBmY2lTZWFyY2guYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCAoKSA9PiB7CiAgICAgIHN0YXRlLmZjaVF1ZXJ5ID0gZmNpU2VhcmNoLnZhbHVlIHx8ICcnOwogICAgICBzdGF0ZS5mY2lQYWdlID0gMTsKICAgICAgcmVuZGVyRmNpUmVudGFGaWphKCk7CiAgICB9KTsKICB9CiAgY29uc3QgZmNpUHJldiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmY2ktcHJldicpOwogIGlmIChmY2lQcmV2KSB7CiAgICBmY2lQcmV2LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgICBzdGF0ZS5mY2lQYWdlID0gTWF0aC5tYXgoMSwgc3RhdGUuZmNpUGFnZSAtIDEpOwogICAgICByZW5kZXJGY2lSZW50YUZpamEoKTsKICAgIH0pOwogIH0KICBjb25zdCBmY2lOZXh0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZjaS1uZXh0Jyk7CiAgaWYgKGZjaU5leHQpIHsKICAgIGZjaU5leHQuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgIHN0YXRlLmZjaVBhZ2UgKz0gMTsKICAgICAgcmVuZGVyRmNpUmVudGFGaWphKCk7CiAgICB9KTsKICB9CgogIGZ1bmN0aW9uIHRvZ2dsZUdsb3MoKSB7CiAgICBjb25zdCBncmlkID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2dsb3NHcmlkJyk7CiAgICBjb25zdCBhcnJvdyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdnbG9zQXJyb3cnKTsKICAgIGNvbnN0IG9wZW4gPSBncmlkLmNsYXNzTGlzdC50b2dnbGUoJ29wZW4nKTsKICAgIGFycm93LnRleHRDb250ZW50ID0gb3BlbiA/ICfilrQnIDogJ+KWvic7CiAgfQoKICBjb25zdCByZXRyeUJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdlcnJvci1yZXRyeS1idG4nKTsKICBpZiAocmV0cnlCdG4pIHsKICAgIHJldHJ5QnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgICBpZiAod2luZG93LnNjaGVkdWxlcikgd2luZG93LnNjaGVkdWxlci5yZXN1bWUoKTsKICAgICAgZmV0Y2hBbGwoeyBtYW51YWw6IHRydWUgfSk7CiAgICB9KTsKICB9CgogIGNvbnN0IGNhY2hlZCA9IGxvYWRDYWNoZSgpOwogIGluaXRIaXN0b3J5Q29sdW1uV2lkdGhzKCk7CiAgYmluZEhpc3RvcnlDb2x1bW5SZXNpemUoKTsKICBpZiAoY2FjaGVkKSB7CiAgICBzdGF0ZS5sYXN0TWVwUGF5bG9hZCA9IGNhY2hlZC5tZXBDY2w7CiAgICByZW5kZXJGY2lSZW50YUZpamEoY2FjaGVkLmZjaVJlbnRhRmlqYSk7CiAgICByZW5kZXJNZXBDY2woY2FjaGVkLm1lcENjbCk7CiAgICByZW5kZXJNZXRyaWNzMjRoKGNhY2hlZC5tZXBDY2wpOwogICAgcmVuZGVyVHJlbmQoY2FjaGVkLm1lcENjbCk7CiAgICByZW5kZXJIaXN0b3J5KGNhY2hlZC5tZXBDY2wpOwogICAgY29uc3QgY2FjaGVkUm9vdCA9IGV4dHJhY3RSb290KGNhY2hlZC5tZXBDY2wpOwogICAgc3RhdGUuc291cmNlVHNNcyA9IHRvTnVtYmVyKGNhY2hlZFJvb3Q/LnNvdXJjZVN0YXR1cz8ubGF0ZXN0U291cmNlVHNNcykKICAgICAgPz8gdG9OdW1iZXIoY2FjaGVkUm9vdD8uY3VycmVudD8ubWVwVHNNcykKICAgICAgPz8gdG9OdW1iZXIoY2FjaGVkUm9vdD8uY3VycmVudD8uY2NsVHNNcykKICAgICAgPz8gbnVsbDsKICAgIHJlZnJlc2hGcmVzaEJhZGdlRnJvbVNvdXJjZSgpOwogIH0KCiAgYXBwbHlGaWx0ZXIoc3RhdGUuZmlsdGVyTW9kZSk7CgogIHdpbmRvdy5zY2hlZHVsZXIgPSBuZXcgTWFya2V0U2NoZWR1bGVyKGZldGNoQWxsLCBGRVRDSF9JTlRFUlZBTF9NUyk7CiAgd2luZG93LnNjaGVkdWxlci5zdGFydCgpOwogIGZldGNoQWxsKHsgbWFudWFsOiB0cnVlIH0pOwoKICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCd2aXNpYmlsaXR5Y2hhbmdlJywgKCkgPT4gewogICAgaWYgKGRvY3VtZW50LmhpZGRlbikgd2luZG93LnNjaGVkdWxlci5wYXVzZSgpOwogICAgZWxzZSB3aW5kb3cuc2NoZWR1bGVyLnJlc3VtZSgpOwogIH0pOwo8L3NjcmlwdD4KPC9ib2R5Pgo8L2h0bWw+Cg==`;

function decodeBase64Utf8(b64) {
  const compact = b64.replace(/\s+/g, "");
  const binary = atob(compact);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function renderDashboardHtml() {
  return decodeBase64Utf8(DASHBOARD_HTML_B64);
}
