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

const DASHBOARD_HTML_B64 = `PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVzIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAiPgo8dGl0bGU+UmFkYXIgTUVQL0NDTCDCtyBNZXJjYWRvIEFSRzwvdGl0bGU+CjxsaW5rIHJlbD0icHJlY29ubmVjdCIgaHJlZj0iaHR0cHM6Ly9mb250cy5nb29nbGVhcGlzLmNvbSI+CjxsaW5rIGhyZWY9Imh0dHBzOi8vZm9udHMuZ29vZ2xlYXBpcy5jb20vY3NzMj9mYW1pbHk9U3BhY2UrTW9ubzp3Z2h0QDQwMDs3MDAmZmFtaWx5PVN5bmU6d2dodEA0MDA7NjAwOzcwMDs4MDAmZGlzcGxheT1zd2FwIiByZWw9InN0eWxlc2hlZXQiPgo8c3R5bGU+Ci8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBUT0tFTlMK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCjpyb290IHsKICAtLWJnOiAgICAgICAjMDgwYjBlOwogIC0tc3VyZjogICAgICMwZjEzMTg7CiAgLS1zdXJmMjogICAgIzE2MWIyMjsKICAtLXN1cmYzOiAgICAjMWMyMzMwOwogIC0tYm9yZGVyOiAgICMxZTI1MzA7CiAgLS1ib3JkZXJCOiAgIzJhMzQ0NDsKCiAgLS1ncmVlbjogICAgIzAwZTY3NjsKICAtLWdyZWVuLWQ6ICByZ2JhKDAsMjMwLDExOCwuMDkpOwogIC0tZ3JlZW4tZzogIHJnYmEoMCwyMzAsMTE4LC4yMik7CiAgLS1yZWQ6ICAgICAgI2ZmNDc1NzsKICAtLXJlZC1kOiAgICByZ2JhKDI1NSw3MSw4NywuMDkpOwogIC0teWVsbG93OiAgICNmZmMgYzAwOwogIC0teWVsbG93OiAgICNmZmNjMDA7CiAgLS15ZWxsb3ctZDogcmdiYSgyNTUsMjA0LDAsLjA5KTsKCiAgLS1tZXA6ICAgICAgIzI5YjZmNjsKICAtLWNjbDogICAgICAjYjM5ZGRiOwogIC0tdGV4dDogICAgICNkZGU0ZWU7CiAgLS1tdXRlZDogICAgIzU1NjA3MDsKICAtLW11dGVkMjogICAjN2E4ZmE4OwoKICAtLW1vbm86ICdTcGFjZSBNb25vJywgbW9ub3NwYWNlOwogIC0tc2FuczogJ1N5bmUnLCBzYW5zLXNlcmlmOwoKICAtLWRyYXdlci13OiA0MDBweDsKICAtLWhlYWRlci1oOiA1NHB4Owp9CgoqLCAqOjpiZWZvcmUsICo6OmFmdGVyIHsgYm94LXNpemluZzogYm9yZGVyLWJveDsgbWFyZ2luOiAwOyBwYWRkaW5nOiAwOyB9CgpodG1sIHsgc2Nyb2xsLWJlaGF2aW9yOiBzbW9vdGg7IH0KCmJvZHkgewogIGJhY2tncm91bmQ6IHZhcigtLWJnKTsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgZm9udC1mYW1pbHk6IHZhcigtLW1vbm8pOwogIG1pbi1oZWlnaHQ6IDEwMHZoOwogIG92ZXJmbG93LXg6IGhpZGRlbjsKfQoKYm9keTo6YmVmb3JlIHsKICBjb250ZW50OiAnJzsKICBwb3NpdGlvbjogZml4ZWQ7IGluc2V0OiAwOwogIGJhY2tncm91bmQtaW1hZ2U6CiAgICBsaW5lYXItZ3JhZGllbnQocmdiYSg0MSwxODIsMjQ2LC4wMjUpIDFweCwgdHJhbnNwYXJlbnQgMXB4KSwKICAgIGxpbmVhci1ncmFkaWVudCg5MGRlZywgcmdiYSg0MSwxODIsMjQ2LC4wMjUpIDFweCwgdHJhbnNwYXJlbnQgMXB4KTsKICBiYWNrZ3JvdW5kLXNpemU6IDQ0cHggNDRweDsKICBwb2ludGVyLWV2ZW50czogbm9uZTsgei1pbmRleDogMDsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIExBWU9VVCBTSEVMTArilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLmFwcCB7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBtaW4taGVpZ2h0OiAxMDB2aDsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIEhFQURFUgrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KaGVhZGVyIHsKICBwb3NpdGlvbjogc3RpY2t5OyB0b3A6IDA7IHotaW5kZXg6IDIwMDsKICBoZWlnaHQ6IHZhcigtLWhlYWRlci1oKTsKICBiYWNrZ3JvdW5kOiByZ2JhKDgsMTEsMTQsLjkzKTsKICBiYWNrZHJvcC1maWx0ZXI6IGJsdXIoMThweCk7CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgcGFkZGluZzogMCAyMnB4OwogIGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsKfQoKLmxvZ28gewogIGZvbnQtZmFtaWx5OiB2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6IDgwMDsgZm9udC1zaXplOiAxNXB4OwogIGxldHRlci1zcGFjaW5nOiAuMDVlbTsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA5cHg7Cn0KCi5saXZlLWRvdCB7CiAgd2lkdGg6IDdweDsgaGVpZ2h0OiA3cHg7IGJvcmRlci1yYWRpdXM6IDUwJTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1ncmVlbik7CiAgYm94LXNoYWRvdzogMCAwIDhweCB2YXIoLS1ncmVlbik7CiAgYW5pbWF0aW9uOiBibGluayAyLjJzIGVhc2UtaW4tb3V0IGluZmluaXRlOwp9CkBrZXlmcmFtZXMgYmxpbmsgewogIDAlLDEwMCV7b3BhY2l0eToxO2JveC1zaGFkb3c6MCAwIDhweCB2YXIoLS1ncmVlbik7fQogIDUwJXtvcGFjaXR5Oi4zNTtib3gtc2hhZG93OjAgMCAzcHggdmFyKC0tZ3JlZW4pO30KfQoKLmhlYWRlci1yaWdodCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMTJweDsgfQoKLmZyZXNoLWJhZGdlIHsKICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDVweDsKICBmb250LXNpemU6IDExcHg7IGNvbG9yOiB2YXIoLS1tdXRlZDIpOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYyKTsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOiAyMHB4OyBwYWRkaW5nOiAzcHggMTFweDsKfQouZnJlc2gtZG90IHsgd2lkdGg6NXB4O2hlaWdodDo1cHg7Ym9yZGVyLXJhZGl1czo1MCU7YmFja2dyb3VuZDp2YXIoLS1ncmVlbik7YW5pbWF0aW9uOmJsaW5rIDIuMnMgZWFzZS1pbi1vdXQgaW5maW5pdGU7IH0KLmZyZXNoLWJhZGdlLmZldGNoaW5nIHsgYW5pbWF0aW9uOiBiYWRnZVB1bHNlIDEuMnMgZWFzZS1pbi1vdXQgaW5maW5pdGU7IH0KLmZyZXNoLWJhZGdlLmVycm9yIHsgY29sb3I6I2ZmZDBkMDsgYm9yZGVyLWNvbG9yOnJnYmEoMjU1LDgyLDgyLC40NSk7IGJhY2tncm91bmQ6cmdiYSgyNTUsODIsODIsLjEyKTsgY3Vyc29yOnBvaW50ZXI7IH0KQGtleWZyYW1lcyBiYWRnZVB1bHNlIHsKICAwJSwxMDAlIHsgb3BhY2l0eToxOyB9CiAgNTAlIHsgb3BhY2l0eTouNjU7IH0KfQoKLnRhZy1tZXJjYWRvIHsKICBmb250LWZhbWlseTogdmFyKC0tc2Fucyk7IGZvbnQtc2l6ZToxMHB4OyBmb250LXdlaWdodDo3MDA7CiAgbGV0dGVyLXNwYWNpbmc6LjA4ZW07IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsKICBiYWNrZ3JvdW5kOnZhcigtLWdyZWVuKTsgY29sb3I6IzAwMDsKICBwYWRkaW5nOjNweCA5cHg7IGJvcmRlci1yYWRpdXM6NHB4Owp9Ci50YWctbWVyY2Fkby5jbG9zZWQgeyBiYWNrZ3JvdW5kOnZhcigtLW11dGVkKTsgY29sb3I6IzBhMGMwZjsgfQoKLmJ0biB7CiAgZm9udC1mYW1pbHk6IHZhcigtLXNhbnMpOyBmb250LXNpemU6MTFweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4wN2VtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7CiAgYm9yZGVyLXJhZGl1czo2cHg7IHBhZGRpbmc6NnB4IDE0cHg7IGN1cnNvcjpwb2ludGVyOwogIGJvcmRlcjpub25lOyB0cmFuc2l0aW9uOiBhbGwgLjE4czsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo2cHg7Cn0KLmJ0bi1hbGVydCB7IGJhY2tncm91bmQ6dmFyKC0tZ3JlZW4pOyBjb2xvcjojMDAwOyB9Ci5idG4tYWxlcnQ6aG92ZXIgeyBiYWNrZ3JvdW5kOiMwMGZmODg7IHRyYW5zZm9ybTp0cmFuc2xhdGVZKC0xcHgpOyB9CgouYnRuLXRhc2FzIHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMik7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyQik7CiAgY29sb3I6IHZhcigtLXRleHQpOwp9Ci5idG4tdGFzYXM6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMyk7IGJvcmRlci1jb2xvcjogdmFyKC0tbXV0ZWQyKTsgfQouYnRuLXRhc2FzLmFjdGl2ZSB7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZjMpOwogIGJvcmRlci1jb2xvcjogdmFyKC0teWVsbG93KTsKICBjb2xvcjogdmFyKC0teWVsbG93KTsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIE1BSU4gKyBEUkFXRVIgTEFZT1VUCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwouYm9keS13cmFwIHsKICBmbGV4OiAxOwogIGRpc3BsYXk6IGZsZXg7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIHotaW5kZXg6IDE7CiAgdHJhbnNpdGlvbjogbm9uZTsKfQoKLm1haW4tY29udGVudCB7CiAgZmxleDogMTsKICBtYXgtd2lkdGg6IDEwMCU7CiAgcGFkZGluZzogMjJweCAyMnB4IDYwcHg7CiAgdHJhbnNpdGlvbjogbWFyZ2luLXJpZ2h0IC4zNXMgY3ViaWMtYmV6aWVyKC40LDAsLjIsMSk7Cn0KCi5ib2R5LXdyYXAuZHJhd2VyLW9wZW4gLm1haW4tY29udGVudCB7CiAgbWFyZ2luLXJpZ2h0OiB2YXIoLS1kcmF3ZXItdyk7Cn0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBEUkFXRVIK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5kcmF3ZXIgewogIHBvc2l0aW9uOiBmaXhlZDsKICB0b3A6IHZhcigtLWhlYWRlci1oKTsKICByaWdodDogMDsKICB3aWR0aDogdmFyKC0tZHJhd2VyLXcpOwogIGhlaWdodDogY2FsYygxMDB2aCAtIHZhcigtLWhlYWRlci1oKSk7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZik7CiAgYm9yZGVyLWxlZnQ6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIHRyYW5zZm9ybTogdHJhbnNsYXRlWCgxMDAlKTsKICB0cmFuc2l0aW9uOiB0cmFuc2Zvcm0gLjM1cyBjdWJpYy1iZXppZXIoLjQsMCwuMiwxKTsKICBvdmVyZmxvdy15OiBhdXRvOwogIHotaW5kZXg6IDE1MDsKICBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwp9CgouZHJhd2VyLm9wZW4geyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVgoMCk7IH0KCi5kcmF3ZXItcmVzaXplciB7CiAgcG9zaXRpb246IGFic29sdXRlOwogIGxlZnQ6IC00cHg7CiAgdG9wOiAwOwogIHdpZHRoOiA4cHg7CiAgaGVpZ2h0OiAxMDAlOwogIGN1cnNvcjogY29sLXJlc2l6ZTsKICB6LWluZGV4OiAxODA7Cn0KLmRyYXdlci1yZXNpemVyOjpiZWZvcmUgewogIGNvbnRlbnQ6ICcnOwogIHBvc2l0aW9uOiBhYnNvbHV0ZTsKICBsZWZ0OiAzcHg7CiAgdG9wOiAwOwogIHdpZHRoOiAycHg7CiAgaGVpZ2h0OiAxMDAlOwogIGJhY2tncm91bmQ6IHRyYW5zcGFyZW50OwogIHRyYW5zaXRpb246IGJhY2tncm91bmQgLjE1czsKfQouZHJhd2VyLXJlc2l6ZXI6aG92ZXI6OmJlZm9yZSwKLmRyYXdlci1yZXNpemVyLmFjdGl2ZTo6YmVmb3JlIHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1tdXRlZDIpOwp9CgouZHJhd2VyLWhlYWRlciB7CiAgcG9zaXRpb246IHN0aWNreTsgdG9wOiAwOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYpOwogIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIHBhZGRpbmc6IDE2cHggMjBweDsKICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47CiAgei1pbmRleDogMTA7Cn0KCi5kcmF3ZXItdGl0bGUgewogIGZvbnQtZmFtaWx5OiB2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6IDgwMDsgZm9udC1zaXplOiAxM3B4OwogIGxldHRlci1zcGFjaW5nOi4wNGVtOyBjb2xvcjogdmFyKC0tdGV4dCk7CiAgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBnYXA6OHB4Owp9CgouZHJhd2VyLXNvdXJjZSB7CiAgZm9udC1zaXplOjEwcHg7IGNvbG9yOnZhcigtLW11dGVkKTsgZm9udC1mYW1pbHk6dmFyKC0tbW9ubyk7Cn0KCi5idG4tY2xvc2UgewogIGJhY2tncm91bmQ6dmFyKC0tc3VyZjIpOyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgY29sb3I6dmFyKC0tbXV0ZWQyKTsgYm9yZGVyLXJhZGl1czo2cHg7IHBhZGRpbmc6NXB4IDEwcHg7CiAgY3Vyc29yOnBvaW50ZXI7IGZvbnQtc2l6ZToxM3B4OyB0cmFuc2l0aW9uOiBhbGwgLjE1czsKfQouYnRuLWNsb3NlOmhvdmVyIHsgY29sb3I6dmFyKC0tdGV4dCk7IGJvcmRlci1jb2xvcjp2YXIoLS1tdXRlZDIpOyB9CgouZHJhd2VyLWJvZHkgeyBwYWRkaW5nOiAxNnB4IDIwcHg7IGRpc3BsYXk6IGZsZXg7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IGdhcDogMjJweDsgfQoKLmNvbnRleHQtYm94IHsKICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSwyMDQsMCwuMDYpOwogIGJvcmRlcjogMXB4IHNvbGlkIHJnYmEoMjU1LDIwNCwwLC4yKTsKICBib3JkZXItcmFkaXVzOiA5cHg7CiAgcGFkZGluZzogMTNweCAxNXB4OwogIGZvbnQtc2l6ZTogMTFweDsKICBsaW5lLWhlaWdodDoxLjY1OwogIGNvbG9yOnZhcigtLW11dGVkMik7Cn0KLmNvbnRleHQtYm94IHN0cm9uZyB7IGNvbG9yOnZhcigtLXllbGxvdyk7IH0KCi5mY2ktaGVhZGVyIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBiYXNlbGluZTsKICBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47CiAgZ2FwOiAxMHB4Owp9Ci5mY2ktdGl0bGUgewogIGZvbnQtZmFtaWx5OiB2YXIoLS1zYW5zKTsKICBmb250LXNpemU6IDEycHg7CiAgZm9udC13ZWlnaHQ6IDcwMDsKICBsZXR0ZXItc3BhY2luZzogLjA1ZW07CiAgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsKICBjb2xvcjogdmFyKC0tdGV4dCk7Cn0KLmZjaS1tZXRhIHsKICBmb250LXNpemU6IDEwcHg7CiAgY29sb3I6IHZhcigtLW11dGVkKTsKfQouZmNpLXRhYmxlLXdyYXAgewogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czogMTBweDsKICBvdmVyZmxvdzogYXV0bzsKfQouZmNpLXRhYmxlIHsKICB3aWR0aDogMTAwJTsKICBib3JkZXItY29sbGFwc2U6IGNvbGxhcHNlOwp9Ci5mY2ktdGFibGUgdGhlYWQgdGggewogIHBvc2l0aW9uOiBzdGlja3k7CiAgdG9wOiAwOwogIHotaW5kZXg6IDU7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZjIpOwogIGNvbG9yOiB2YXIoLS1tdXRlZDIpOwogIGZvbnQtc2l6ZTogMTBweDsKICBsZXR0ZXItc3BhY2luZzogLjA4ZW07CiAgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsKICB0ZXh0LWFsaWduOiBsZWZ0OwogIHBhZGRpbmc6IDlweCAxMHB4OwogIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwp9Ci5mY2ktdGFibGUgdGhlYWQgdGg6aG92ZXIgewogIHotaW5kZXg6IDgwOwp9Ci5mY2ktdGFibGUgdGJvZHkgdHIgewogIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwp9Ci5mY2ktdGFibGUgdGJvZHkgdHI6bGFzdC1jaGlsZCB7CiAgYm9yZGVyLWJvdHRvbTogbm9uZTsKfQouZmNpLXRhYmxlIHRkIHsKICBmb250LXNpemU6IDExcHg7CiAgY29sb3I6IHZhcigtLXRleHQpOwogIHBhZGRpbmc6IDlweCAxMHB4OwogIHdoaXRlLXNwYWNlOiBub3dyYXA7Cn0KLmZjaS1lbXB0eSB7CiAgZm9udC1zaXplOiAxMXB4OwogIGNvbG9yOiB2YXIoLS1tdXRlZDIpOwogIHBhZGRpbmc6IDEycHg7CiAgYm9yZGVyOiAxcHggZGFzaGVkIHZhcigtLWJvcmRlckIpOwogIGJvcmRlci1yYWRpdXM6IDEwcHg7Cn0KLmZjaS1jb250cm9scyB7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsKICBnYXA6IDEwcHg7Cn0KLmZjaS1zZWFyY2ggewogIHdpZHRoOiAxMDAlOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYyKTsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXJCKTsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgYm9yZGVyLXJhZGl1czogOHB4OwogIHBhZGRpbmc6IDhweCAxMHB4OwogIGZvbnQtc2l6ZTogMTFweDsKICBvdXRsaW5lOiBub25lOwp9Ci5mY2ktc2VhcmNoOmZvY3VzIHsKICBib3JkZXItY29sb3I6IHZhcigtLW11dGVkMik7Cn0KLmZjaS1wYWdpbmF0aW9uIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiA4cHg7CiAgZmxleC1zaHJpbms6IDA7Cn0KLmZjaS1wYWdlLWJ0biB7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZjIpOwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlckIpOwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKICBib3JkZXItcmFkaXVzOiA2cHg7CiAgZm9udC1zaXplOiAxMHB4OwogIGZvbnQtd2VpZ2h0OiA3MDA7CiAgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsKICBsZXR0ZXItc3BhY2luZzogLjA2ZW07CiAgcGFkZGluZzogNXB4IDhweDsKICBjdXJzb3I6IHBvaW50ZXI7Cn0KLmZjaS1wYWdlLWJ0bjpkaXNhYmxlZCB7CiAgb3BhY2l0eTogLjQ7CiAgY3Vyc29yOiBkZWZhdWx0Owp9Ci5mY2ktcGFnZS1pbmZvIHsKICBmb250LXNpemU6IDEwcHg7CiAgY29sb3I6IHZhcigtLW11dGVkMik7Cn0KLmZjaS1kZWx0YSB7CiAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDVweDsKfQouZmNpLWRlbHRhLWljb24gewogIGZvbnQtc2l6ZTogMTBweDsKICBmb250LXdlaWdodDogNzAwOwogIGxldHRlci1zcGFjaW5nOiAuMDJlbTsKfQouZmNpLWRlbHRhLXVwIC5mY2ktZGVsdGEtaWNvbiB7IGNvbG9yOiB2YXIoLS1ncmVlbik7IH0KLmZjaS1kZWx0YS1kb3duIC5mY2ktZGVsdGEtaWNvbiB7IGNvbG9yOiB2YXIoLS1yZWQpOyB9Ci5mY2ktZGVsdGEtZmxhdCAuZmNpLWRlbHRhLWljb24geyBjb2xvcjogdmFyKC0tbXV0ZWQyKTsgfQouZmNpLWRlbHRhLW5hIC5mY2ktZGVsdGEtaWNvbiB7IGNvbG9yOiB2YXIoLS1tdXRlZCk7IH0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBTVEFUVVMgQkFOTkVSCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwouc3RhdHVzLWJhbm5lciB7CiAgYm9yZGVyLXJhZGl1czoxMXB4OyBwYWRkaW5nOjE4cHggMjRweDsgbWFyZ2luLWJvdHRvbToyMHB4OwogIGJvcmRlcjoxcHggc29saWQ7IGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOwogIGp1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuOwogIGFuaW1hdGlvbjpmYWRlSW4gLjRzIGVhc2U7CiAgb3ZlcmZsb3c6aGlkZGVuOyBwb3NpdGlvbjpyZWxhdGl2ZTsKfQouc3RhdHVzLWJhbm5lci5zaW1pbGFyIHsKICBiYWNrZ3JvdW5kOnZhcigtLWdyZWVuLWQpOyBib3JkZXItY29sb3I6cmdiYSgwLDIzMCwxMTgsLjI4KTsKfQouc3RhdHVzLWJhbm5lci5zaW1pbGFyOjphZnRlciB7CiAgY29udGVudDonJzsgcG9zaXRpb246YWJzb2x1dGU7IHJpZ2h0Oi01MHB4OyB0b3A6NTAlOwogIHRyYW5zZm9ybTp0cmFuc2xhdGVZKC01MCUpOyB3aWR0aDoyMDBweDsgaGVpZ2h0OjIwMHB4OwogIGJvcmRlci1yYWRpdXM6NTAlOwogIGJhY2tncm91bmQ6cmFkaWFsLWdyYWRpZW50KGNpcmNsZSx2YXIoLS1ncmVlbi1nKSAwJSx0cmFuc3BhcmVudCA3MCUpOwogIHBvaW50ZXItZXZlbnRzOm5vbmU7Cn0KLnN0YXR1cy1iYW5uZXIubm8tc2ltaWxhciB7CiAgYmFja2dyb3VuZDogcmdiYSgyNTUsODIsODIsLjA4KTsKICBib3JkZXItY29sb3I6IHJnYmEoMjU1LDgyLDgyLC4zNSk7Cn0KLnN0YXR1cy1iYW5uZXIubm8tc2ltaWxhcjo6YWZ0ZXIgewogIGNvbnRlbnQ6Jyc7CiAgcG9zaXRpb246YWJzb2x1dGU7CiAgcmlnaHQ6LTUwcHg7CiAgdG9wOjUwJTsKICB0cmFuc2Zvcm06dHJhbnNsYXRlWSgtNTAlKTsKICB3aWR0aDoyMDBweDsKICBoZWlnaHQ6MjAwcHg7CiAgYm9yZGVyLXJhZGl1czo1MCU7CiAgYmFja2dyb3VuZDpyYWRpYWwtZ3JhZGllbnQoY2lyY2xlLHJnYmEoMjU1LDgyLDgyLC4xOCkgMCUsdHJhbnNwYXJlbnQgNzAlKTsKICBwb2ludGVyLWV2ZW50czpub25lOwp9Cgoucy1sZWZ0IHt9Ci5zLXRpdGxlIHsKICBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6ODAwOyBmb250LXNpemU6MjZweDsKICBsZXR0ZXItc3BhY2luZzotLjAyZW07IGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBnYXA6MTJweDsKfQoucy1iYWRnZSB7CiAgZm9udC1zaXplOjEwcHg7IGZvbnQtd2VpZ2h0OjcwMDsgbGV0dGVyLXNwYWNpbmc6LjFlbTsKICB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7IHBhZGRpbmc6MnB4IDlweDsgYm9yZGVyLXJhZGl1czo0cHg7CiAgYmFja2dyb3VuZDp2YXIoLS1ncmVlbik7IGNvbG9yOiMwMDA7IGFsaWduLXNlbGY6Y2VudGVyOwp9Ci5zLWJhZGdlLm5vc2ltIHsgYmFja2dyb3VuZDogdmFyKC0tcmVkKTsgY29sb3I6ICNmZmY7IH0KLnMtc3ViIHsgZm9udC1zaXplOjExcHg7IGNvbG9yOnZhcigtLW11dGVkMik7IG1hcmdpbi10b3A6NHB4OyB9CgouZXJyb3ItYmFubmVyIHsKICBkaXNwbGF5Om5vbmU7CiAgbWFyZ2luOiAwIDAgMTRweCAwOwogIHBhZGRpbmc6IDEwcHggMTJweDsKICBib3JkZXItcmFkaXVzOiA4cHg7CiAgYm9yZGVyOiAxcHggc29saWQgcmdiYSgyNTUsODIsODIsLjQ1KTsKICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSw4Miw4MiwuMTIpOwogIGNvbG9yOiAjZmZkMGQwOwogIGZvbnQtc2l6ZTogMTFweDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsKICBnYXA6IDEwcHg7Cn0KLmVycm9yLWJhbm5lci5zaG93IHsgZGlzcGxheTpmbGV4OyB9Ci5lcnJvci1iYW5uZXIgYnV0dG9uIHsKICBib3JkZXI6MXB4IHNvbGlkIHJnYmEoMjU1LDgyLDgyLC41KTsKICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSw4Miw4MiwuMTUpOwogIGNvbG9yOiNmZmRlZGU7CiAgYm9yZGVyLXJhZGl1czo2cHg7CiAgcGFkZGluZzo0cHggMTBweDsKICBmb250LXNpemU6MTBweDsKICBmb250LXdlaWdodDo3MDA7CiAgdGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOwogIGxldHRlci1zcGFjaW5nOi4wNmVtOwogIGN1cnNvcjpwb2ludGVyOwp9Cgouc2tlbGV0b24gewogIGJhY2tncm91bmQ6IGxpbmVhci1ncmFkaWVudCg5MGRlZywgIzFjMjMzMCAyNSUsICMyYTM0NDQgNTAlLCAjMWMyMzMwIDc1JSk7CiAgYmFja2dyb3VuZC1zaXplOiAyMDAlIDEwMCU7CiAgYW5pbWF0aW9uOiBzaGltbWVyIDEuNHMgaW5maW5pdGU7CiAgYm9yZGVyLXJhZGl1czogNHB4OwogIGNvbG9yOiB0cmFuc3BhcmVudDsKICB1c2VyLXNlbGVjdDogbm9uZTsKfQpAa2V5ZnJhbWVzIHNoaW1tZXIgewogIDAlICAgeyBiYWNrZ3JvdW5kLXBvc2l0aW9uOiAyMDAlIDA7IH0KICAxMDAlIHsgYmFja2dyb3VuZC1wb3NpdGlvbjogLTIwMCUgMDsgfQp9CgoudmFsdWUtY2hhbmdlZCB7CiAgYW5pbWF0aW9uOiBmbGFzaFZhbHVlIDYwMG1zIGVhc2U7Cn0KQGtleWZyYW1lcyBmbGFzaFZhbHVlIHsKICAwJSAgIHsgY29sb3I6ICNmZmNjMDA7IH0KICAxMDAlIHsgY29sb3I6IGluaGVyaXQ7IH0KfQoKLnMtcmlnaHQgeyB0ZXh0LWFsaWduOnJpZ2h0OyBmb250LXNpemU6MTFweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBsaW5lLWhlaWdodDoxLjk7IH0KLnMtcmlnaHQgc3Ryb25nIHsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIEhFUk8gQ0FSRFMK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5oZXJvLWdyaWQgewogIGRpc3BsYXk6Z3JpZDsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnIgMWZyOwogIGdhcDoxNHB4OyBtYXJnaW4tYm90dG9tOjIwcHg7Cn0KCi5oY2FyZCB7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmKTsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yYWRpdXM6MTFweDsgcGFkZGluZzoyMHB4IDIycHg7CiAgcG9zaXRpb246cmVsYXRpdmU7IG92ZXJmbG93OmhpZGRlbjsKICB0cmFuc2l0aW9uOmJvcmRlci1jb2xvciAuMThzOwogIGFuaW1hdGlvbjogZmFkZVVwIC41cyBlYXNlIGJvdGg7Cn0KLmhjYXJkOm50aC1jaGlsZCgxKXthbmltYXRpb24tZGVsYXk6LjA4czt9Ci5oY2FyZDpudGgtY2hpbGQoMil7YW5pbWF0aW9uLWRlbGF5Oi4xNnM7fQouaGNhcmQ6bnRoLWNoaWxkKDMpe2FuaW1hdGlvbi1kZWxheTouMjRzO30KLmhjYXJkOmhvdmVyIHsgYm9yZGVyLWNvbG9yOnZhcigtLWJvcmRlckIpOyB9CgouaGNhcmQgLmJhciB7IHBvc2l0aW9uOmFic29sdXRlOyB0b3A6MDtsZWZ0OjA7cmlnaHQ6MDsgaGVpZ2h0OjJweDsgfQouaGNhcmQubWVwIC5iYXIgeyBiYWNrZ3JvdW5kOnZhcigtLW1lcCk7IH0KLmhjYXJkLmNjbCAuYmFyIHsgYmFja2dyb3VuZDp2YXIoLS1jY2wpOyB9Ci5oY2FyZC5nYXAgLmJhciB7IGJhY2tncm91bmQ6dmFyKC0teWVsbG93KTsgfQoKLmhjYXJkLWxhYmVsIHsKICBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC1zaXplOjEwcHg7IGZvbnQtd2VpZ2h0OjcwMDsKICBsZXR0ZXItc3BhY2luZzouMTJlbTsgdGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOyBjb2xvcjp2YXIoLS1tdXRlZCk7CiAgbWFyZ2luLWJvdHRvbTo5cHg7IGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBnYXA6NXB4Owp9Ci5oY2FyZC1sYWJlbCAuZG90IHsgd2lkdGg6NXB4O2hlaWdodDo1cHg7Ym9yZGVyLXJhZGl1czo1MCU7IH0KLm1lcCAuZG90e2JhY2tncm91bmQ6dmFyKC0tbWVwKTt9Ci5jY2wgLmRvdHtiYWNrZ3JvdW5kOnZhcigtLWNjbCk7fQouZ2FwIC5kb3R7YmFja2dyb3VuZDp2YXIoLS15ZWxsb3cpO30KCi5oY2FyZC12YWwgewogIGZvbnQtc2l6ZTozNHB4OyBmb250LXdlaWdodDo3MDA7IGxldHRlci1zcGFjaW5nOi0uMDJlbTsgbGluZS1oZWlnaHQ6MTsKfQoubWVwIC5oY2FyZC12YWx7Y29sb3I6dmFyKC0tbWVwKTt9Ci5jY2wgLmhjYXJkLXZhbHtjb2xvcjp2YXIoLS1jY2wpO30KCi5oY2FyZC1wY3QgeyBmb250LXNpemU6MjBweDsgY29sb3I6dmFyKC0teWVsbG93KTsgZm9udC13ZWlnaHQ6NzAwOyBtYXJnaW4tdG9wOjNweDsgfQouaGNhcmQtc3ViIHsgZm9udC1zaXplOjEwcHg7IGNvbG9yOnZhcigtLW11dGVkKTsgbWFyZ2luLXRvcDo3cHg7IH0KCi8qIHRvb2x0aXAgKi8KLnRpcCB7IHBvc2l0aW9uOnJlbGF0aXZlOyBjdXJzb3I6aGVscDsgfQoudGlwOjphZnRlciB7CiAgY29udGVudDphdHRyKGRhdGEtdCk7CiAgcG9zaXRpb246YWJzb2x1dGU7IGJvdHRvbTpjYWxjKDEwMCUgKyA3cHgpOyBsZWZ0OjUwJTsKICB0cmFuc2Zvcm06dHJhbnNsYXRlWCgtNTAlKTsKICBiYWNrZ3JvdW5kOiMxYTIyMzI7IGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyQik7CiAgY29sb3I6dmFyKC0tdGV4dCk7IGZvbnQtc2l6ZToxMHB4OyBwYWRkaW5nOjVweCA5cHg7CiAgYm9yZGVyLXJhZGl1czo2cHg7IHdoaXRlLXNwYWNlOm5vd3JhcDsKICBvcGFjaXR5OjA7IHBvaW50ZXItZXZlbnRzOm5vbmU7IHRyYW5zaXRpb246b3BhY2l0eSAuMThzOyB6LWluZGV4Ojk5Owp9Ci50aXA6aG92ZXI6OmFmdGVye29wYWNpdHk6MTt9Ci50aXAudGlwLWRvd246OmFmdGVyIHsKICBkaXNwbGF5OiBub25lOwp9Cgouc21hcnQtdGlwIHsKICBwb3NpdGlvbjogZml4ZWQ7CiAgbGVmdDogMDsKICB0b3A6IDA7CiAgbWF4LXdpZHRoOiBtaW4oMjgwcHgsIGNhbGMoMTAwdncgLSAxNnB4KSk7CiAgYmFja2dyb3VuZDogIzFhMjIzMjsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXJCKTsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgZm9udC1zaXplOiAxMHB4OwogIGxpbmUtaGVpZ2h0OiAxLjQ1OwogIHBhZGRpbmc6IDZweCA5cHg7CiAgYm9yZGVyLXJhZGl1czogNnB4OwogIHotaW5kZXg6IDQwMDsKICBvcGFjaXR5OiAwOwogIHBvaW50ZXItZXZlbnRzOiBub25lOwogIHRyYW5zaXRpb246IG9wYWNpdHkgLjEyczsKfQouc21hcnQtdGlwLnNob3cgewogIG9wYWNpdHk6IDE7Cn0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBDSEFSVArilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLmNoYXJ0LWNhcmQgewogIGJhY2tncm91bmQ6dmFyKC0tc3VyZik7IGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOjExcHg7IHBhZGRpbmc6MjJweDsgbWFyZ2luLWJvdHRvbToyMHB4OwogIGFuaW1hdGlvbjpmYWRlVXAgLjVzIC4zMnMgZWFzZSBib3RoOwp9Ci5jaGFydC10b3AgewogIGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjsKICBtYXJnaW4tYm90dG9tOjE2cHg7Cn0KLmNoYXJ0LXR0bCB7IGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXdlaWdodDo3MDA7IGZvbnQtc2l6ZToxM3B4OyB9CgoucGlsbHMgeyBkaXNwbGF5OmZsZXg7IGdhcDo1cHg7IH0KLnBpbGwgewogIGZvbnQtc2l6ZToxMHB4OyBwYWRkaW5nOjNweCAxMXB4OyBib3JkZXItcmFkaXVzOjIwcHg7CiAgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXJCKTsgY29sb3I6dmFyKC0tbXV0ZWQyKTsKICBiYWNrZ3JvdW5kOnRyYW5zcGFyZW50OyBjdXJzb3I6cG9pbnRlcjsgZm9udC1mYW1pbHk6dmFyKC0tbW9ubyk7CiAgdHJhbnNpdGlvbjphbGwgLjEzczsKfQoucGlsbC5vbiB7IGJhY2tncm91bmQ6dmFyKC0tbWVwKTsgYm9yZGVyLWNvbG9yOnZhcigtLW1lcCk7IGNvbG9yOiMwMDA7IGZvbnQtd2VpZ2h0OjcwMDsgfQoKLmxlZ2VuZHMgeyBkaXNwbGF5OmZsZXg7IGdhcDoxOHB4OyBtYXJnaW4tYm90dG9tOjE0cHg7IGZvbnQtc2l6ZToxMHB4OyBjb2xvcjp2YXIoLS1tdXRlZDIpOyB9Ci5sZWcgeyBkaXNwbGF5OmZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsgZ2FwOjVweDsgfQoubGVnLWxpbmUgeyB3aWR0aDoxOHB4OyBoZWlnaHQ6MnB4OyBib3JkZXItcmFkaXVzOjJweDsgfQoKc3ZnLmNoYXJ0IHsgd2lkdGg6MTAwJTsgaGVpZ2h0OjE3MHB4OyBvdmVyZmxvdzp2aXNpYmxlOyB9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgTUVUUklDUwrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLm1ldHJpY3MtZ3JpZCB7CiAgZGlzcGxheTpncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDQsMWZyKTsKICBnYXA6MTJweDsgbWFyZ2luLWJvdHRvbToyMHB4Owp9Ci5tY2FyZCB7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmMik7IGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOjlweDsgcGFkZGluZzoxNHB4IDE2cHg7CiAgYW5pbWF0aW9uOmZhZGVVcCAuNXMgZWFzZSBib3RoOwp9Ci5tY2FyZDpudGgtY2hpbGQoMSl7YW5pbWF0aW9uLWRlbGF5Oi4zOHM7fQoubWNhcmQ6bnRoLWNoaWxkKDIpe2FuaW1hdGlvbi1kZWxheTouNDNzO30KLm1jYXJkOm50aC1jaGlsZCgzKXthbmltYXRpb24tZGVsYXk6LjQ4czt9Ci5tY2FyZDpudGgtY2hpbGQoNCl7YW5pbWF0aW9uLWRlbGF5Oi41M3M7fQoubWNhcmQtbGFiZWwgewogIGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXNpemU6OXB4OyBmb250LXdlaWdodDo3MDA7CiAgbGV0dGVyLXNwYWNpbmc6LjFlbTsgdGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOyBjb2xvcjp2YXIoLS1tdXRlZCk7IG1hcmdpbi1ib3R0b206N3B4Owp9Ci5tY2FyZC12YWwgeyBmb250LXNpemU6MjBweDsgZm9udC13ZWlnaHQ6NzAwOyB9Ci5tY2FyZC1zdWIgeyBmb250LXNpemU6OXB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7IG1hcmdpbi10b3A6M3B4OyB9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgVEFCTEUK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi50YWJsZS1jYXJkIHsKICBiYWNrZ3JvdW5kOnZhcigtLXN1cmYpOyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czoxMXB4OyBvdmVyZmxvdzpoaWRkZW47CiAgYW5pbWF0aW9uOmZhZGVVcCAuNXMgLjU2cyBlYXNlIGJvdGg7Cn0KLnRhYmxlLXRvcCB7CiAgcGFkZGluZzoxNHB4IDIycHg7IGJvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGp1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuOwp9Ci50YWJsZS10dGwgeyBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6NzAwOyBmb250LXNpemU6MTNweDsgfQoudGFibGUtcmlnaHQgeyBkaXNwbGF5OmZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsgZ2FwOjEwcHg7IH0KLnRhYmxlLWNhcCB7IGZvbnQtc2l6ZToxMHB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7IH0KLmJ0bi1kb3dubG9hZCB7CiAgZGlzcGxheTppbmxpbmUtZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBnYXA6NnB4OwogIGhlaWdodDoyNnB4OyBwYWRkaW5nOjAgMTBweDsgYm9yZGVyLXJhZGl1czo3cHg7CiAgYm9yZGVyOjFweCBzb2xpZCAjMmY0ZjY4OyBiYWNrZ3JvdW5kOnJnYmEoNDEsMTgyLDI0NiwwLjA2KTsKICBjb2xvcjojOGZkOGZmOyBjdXJzb3I6cG9pbnRlcjsgZm9udC1mYW1pbHk6dmFyKC0tbW9ubyk7IGZvbnQtc2l6ZToxMHB4OwogIGxldHRlci1zcGFjaW5nOi4wMmVtOwogIHRyYW5zaXRpb246Ym9yZGVyLWNvbG9yIC4xNXMgZWFzZSwgYmFja2dyb3VuZCAuMTVzIGVhc2UsIGNvbG9yIC4xNXMgZWFzZSwgYm94LXNoYWRvdyAuMTVzIGVhc2U7Cn0KLmJ0bi1kb3dubG9hZCBzdmcgewogIHdpZHRoOjEycHg7IGhlaWdodDoxMnB4OyBzdHJva2U6Y3VycmVudENvbG9yOyBmaWxsOm5vbmU7IHN0cm9rZS13aWR0aDoxLjg7Cn0KLmJ0bi1kb3dubG9hZDpob3ZlciB7CiAgYm9yZGVyLWNvbG9yOiM0ZmMzZjc7IGJhY2tncm91bmQ6cmdiYSg0MSwxODIsMjQ2LDAuMTYpOwogIGNvbG9yOiNjNmVjZmY7IGJveC1zaGFkb3c6MCAwIDAgMXB4IHJnYmEoNzksMTk1LDI0NywuMTgpIGluc2V0Owp9CgouaGlzdG9yeS10YWJsZS13cmFwIHsgb3ZlcmZsb3cteDphdXRvOyB9Ci5oaXN0b3J5LXRhYmxlLXdyYXAgdGFibGUgewogIG1pbi13aWR0aDogODYwcHg7Cn0KdGFibGUgeyB3aWR0aDoxMDAlOyBib3JkZXItY29sbGFwc2U6Y29sbGFwc2U7IHRhYmxlLWxheW91dDpmaXhlZDsgfQp0aGVhZCB0aCB7CiAgZm9udC1zaXplOjlweDsgbGV0dGVyLXNwYWNpbmc6LjFlbTsgdGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOwogIGNvbG9yOnZhcigtLW11dGVkKTsgcGFkZGluZzo5cHggMjJweDsgdGV4dC1hbGlnbjpsZWZ0OwogIGJhY2tncm91bmQ6dmFyKC0tc3VyZjIpOyBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6NjAwOwogIHBvc2l0aW9uOnJlbGF0aXZlOwp9CnRib2R5IHRyIHsgYm9yZGVyLWJvdHRvbToxcHggc29saWQgdmFyKC0tYm9yZGVyKTsgdHJhbnNpdGlvbjpiYWNrZ3JvdW5kIC4xMnM7IH0KdGJvZHkgdHI6aG92ZXIgeyBiYWNrZ3JvdW5kOnJnYmEoNDEsMTgyLDI0NiwuMDQpOyB9CnRib2R5IHRyOmxhc3QtY2hpbGQgeyBib3JkZXItYm90dG9tOm5vbmU7IH0KdGJvZHkgdGQgewogIHBhZGRpbmc6MTFweCAyMnB4OyBmb250LXNpemU6MTJweDsKICBvdmVyZmxvdzpoaWRkZW47IHRleHQtb3ZlcmZsb3c6ZWxsaXBzaXM7IHdoaXRlLXNwYWNlOm5vd3JhcDsKfQp0ZC5kaW0geyBjb2xvcjp2YXIoLS1tdXRlZDIpOyBmb250LXNpemU6MTFweDsgfQp0ZC5kaW0gLnRzLWRheSB7IGZvbnQtc2l6ZTo5cHg7IGNvbG9yOnZhcigtLW11dGVkKTsgbGluZS1oZWlnaHQ6MS4xOyB9CnRkLmRpbSAudHMtaG91ciB7IGZvbnQtc2l6ZToxMXB4OyBjb2xvcjp2YXIoLS1tdXRlZDIpOyBsaW5lLWhlaWdodDoxLjI7IG1hcmdpbi10b3A6MnB4OyB9Ci5jb2wtbGFiZWwgeyBwYWRkaW5nLXJpZ2h0OjEwcHg7IGRpc3BsYXk6aW5saW5lLWJsb2NrOyB9Ci5jb2wtcmVzaXplciB7CiAgcG9zaXRpb246YWJzb2x1dGU7CiAgdG9wOjA7CiAgcmlnaHQ6LTRweDsKICB3aWR0aDo4cHg7CiAgaGVpZ2h0OjEwMCU7CiAgY3Vyc29yOmNvbC1yZXNpemU7CiAgdXNlci1zZWxlY3Q6bm9uZTsKICB0b3VjaC1hY3Rpb246bm9uZTsKICB6LWluZGV4OjI7Cn0KLmNvbC1yZXNpemVyOjphZnRlciB7CiAgY29udGVudDonJzsKICBwb3NpdGlvbjphYnNvbHV0ZTsKICB0b3A6NnB4OwogIGJvdHRvbTo2cHg7CiAgbGVmdDozcHg7CiAgd2lkdGg6MXB4OwogIGJhY2tncm91bmQ6cmdiYSgxMjIsMTQzLDE2OCwuMjgpOwp9Ci5jb2wtcmVzaXplcjpob3Zlcjo6YWZ0ZXIsCi5jb2wtcmVzaXplci5hY3RpdmU6OmFmdGVyIHsKICBiYWNrZ3JvdW5kOnJnYmEoMTIyLDE0MywxNjgsLjc1KTsKfQoKLnNiYWRnZSB7CiAgZGlzcGxheTppbmxpbmUtYmxvY2s7IGZvbnQtc2l6ZTo5cHg7IGZvbnQtd2VpZ2h0OjcwMDsKICBsZXR0ZXItc3BhY2luZzouMDhlbTsgcGFkZGluZzoycHggN3B4OyBib3JkZXItcmFkaXVzOjRweDsKICB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7Cn0KLnNiYWRnZS5zaW0geyBiYWNrZ3JvdW5kOnZhcigtLWdyZWVuLWQpOyBjb2xvcjp2YXIoLS1ncmVlbik7IGJvcmRlcjoxcHggc29saWQgcmdiYSgwLDIzMCwxMTgsLjIpOyB9Ci5zYmFkZ2Uubm9zaW0geyBiYWNrZ3JvdW5kOnZhcigtLXJlZC1kKTsgY29sb3I6dmFyKC0tcmVkKTsgYm9yZGVyOjFweCBzb2xpZCByZ2JhKDI1NSw3MSw4NywuMik7IH0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBGT09URVIgLyBHTE9TQVJJTwrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLmdsb3NhcmlvIHsKICBtYXJnaW4tdG9wOjIwcHg7IGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOjExcHg7IG92ZXJmbG93OmhpZGRlbjsKICBhbmltYXRpb246ZmFkZVVwIC41cyAuNnMgZWFzZSBib3RoOwp9Ci5nbG9zLWJ0biB7CiAgd2lkdGg6MTAwJTsgYmFja2dyb3VuZDp2YXIoLS1zdXJmKTsgYm9yZGVyOm5vbmU7CiAgY29sb3I6dmFyKC0tbXV0ZWQyKTsgZm9udC1mYW1pbHk6dmFyKC0tbW9ubyk7IGZvbnQtc2l6ZToxMXB4OwogIHBhZGRpbmc6MTNweCAyMnB4OyB0ZXh0LWFsaWduOmxlZnQ7IGN1cnNvcjpwb2ludGVyOwogIGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjsKICB0cmFuc2l0aW9uOmNvbG9yIC4xNXM7Cn0KLmdsb3MtYnRuOmhvdmVyIHsgY29sb3I6dmFyKC0tdGV4dCk7IH0KCi5nbG9zLWdyaWQgewogIGRpc3BsYXk6bm9uZTsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnI7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmMik7IGJvcmRlci10b3A6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Cn0KLmdsb3MtZ3JpZC5vcGVuIHsgZGlzcGxheTpncmlkOyB9CgouZ2kgewogIHBhZGRpbmc6MTRweCAyMnB4OyBib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yaWdodDoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKfQouZ2k6bnRoLWNoaWxkKGV2ZW4pe2JvcmRlci1yaWdodDpub25lO30KLmdpLXRlcm0gewogIGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXNpemU6MTBweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4wOGVtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7IGNvbG9yOnZhcigtLW11dGVkMik7IG1hcmdpbi1ib3R0b206M3B4Owp9Ci5naS1kZWYgeyBmb250LXNpemU6MTFweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBsaW5lLWhlaWdodDoxLjU7IH0KCmZvb3RlciB7CiAgdGV4dC1hbGlnbjpjZW50ZXI7IHBhZGRpbmc6MjJweDsgZm9udC1zaXplOjEwcHg7IGNvbG9yOnZhcigtLW11dGVkKTsKICBib3JkZXItdG9wOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwp9CmZvb3RlciBhIHsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgdGV4dC1kZWNvcmF0aW9uOm5vbmU7IH0KZm9vdGVyIGE6aG92ZXIgeyBjb2xvcjp2YXIoLS10ZXh0KTsgfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIEFOSU1BVElPTlMK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCkBrZXlmcmFtZXMgZmFkZUluIHsgZnJvbXtvcGFjaXR5OjA7fXRve29wYWNpdHk6MTt9IH0KQGtleWZyYW1lcyBmYWRlVXAgeyBmcm9te29wYWNpdHk6MDt0cmFuc2Zvcm06dHJhbnNsYXRlWSgxMHB4KTt9dG97b3BhY2l0eToxO3RyYW5zZm9ybTp0cmFuc2xhdGVZKDApO30gfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIFJFU1BPTlNJVkUK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCkBtZWRpYShtYXgtd2lkdGg6OTAwcHgpewogIDpyb290eyAtLWRyYXdlci13OiAxMDB2dzsgfQogIC5ib2R5LXdyYXAuZHJhd2VyLW9wZW4gLm1haW4tY29udGVudCB7IG1hcmdpbi1yaWdodDowOyB9CiAgLmRyYXdlciB7IHdpZHRoOjEwMHZ3OyB9CiAgLmRyYXdlci1yZXNpemVyIHsgZGlzcGxheTpub25lOyB9Cn0KQG1lZGlhKG1heC13aWR0aDo3MDBweCl7CiAgLmhlcm8tZ3JpZHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnI7IH0KICAuaGNhcmQuZ2FweyBncmlkLWNvbHVtbjpzcGFuIDI7IH0KICAubWV0cmljcy1ncmlkeyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcjsgfQogIC5oY2FyZC12YWx7IGZvbnQtc2l6ZToyNnB4OyB9CiAgLnBpbGxzeyBmbGV4LXdyYXA6d3JhcDsgfQogIC50YWJsZS1yaWdodCB7IGdhcDo4cHg7IH0KICAuYnRuLWRvd25sb2FkIHsgcGFkZGluZzowIDhweDsgfQogIHRoZWFkIHRoOm50aC1jaGlsZCg0KSwgdGJvZHkgdGQ6bnRoLWNoaWxkKDQpeyBkaXNwbGF5Om5vbmU7IH0KICAucy1yaWdodCB7IGRpc3BsYXk6bm9uZTsgfQogIHRkLmRpbSAudHMtZGF5IHsgZm9udC1zaXplOjhweDsgfQogIHRkLmRpbSAudHMtaG91ciB7IGZvbnQtc2l6ZToxMHB4OyB9Cn0KQG1lZGlhKG1heC13aWR0aDo0ODBweCl7CiAgLmhlcm8tZ3JpZHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcjsgfQogIC5oY2FyZC5nYXB7IGdyaWQtY29sdW1uOnNwYW4gMTsgfQogIGhlYWRlcnsgcGFkZGluZzowIDE0cHg7IH0KICAudGFnLW1lcmNhZG97IGRpc3BsYXk6bm9uZTsgfQogIC5idG4tdGFzYXMgc3Bhbi5sYWJlbC1sb25nIHsgZGlzcGxheTpub25lOyB9Cn0KCi8qIERSQVdFUiBPVkVSTEFZIChtb2JpbGUpICovCi5vdmVybGF5IHsKICBkaXNwbGF5Om5vbmU7CiAgcG9zaXRpb246Zml4ZWQ7IGluc2V0OjA7IHotaW5kZXg6MTQwOwogIGJhY2tncm91bmQ6cmdiYSgwLDAsMCwuNTUpOwogIGJhY2tkcm9wLWZpbHRlcjpibHVyKDJweCk7Cn0KQG1lZGlhKG1heC13aWR0aDo5MDBweCl7CiAgLm92ZXJsYXkuc2hvdyB7IGRpc3BsYXk6YmxvY2s7IH0KfQo8L3N0eWxlPgo8L2hlYWQ+Cjxib2R5Pgo8ZGl2IGNsYXNzPSJhcHAiPgoKPCEtLSDilIDilIAgSEVBREVSIOKUgOKUgCAtLT4KPGhlYWRlcj4KICA8ZGl2IGNsYXNzPSJsb2dvIj4KICAgIDxzcGFuIGNsYXNzPSJsaXZlLWRvdCI+PC9zcGFuPgogICAgUkFEQVIgTUVQL0NDTAogIDwvZGl2PgogIDxkaXYgY2xhc3M9ImhlYWRlci1yaWdodCI+CiAgICA8ZGl2IGNsYXNzPSJmcmVzaC1iYWRnZSIgaWQ9ImZyZXNoLWJhZGdlIj4KICAgICAgPHNwYW4gY2xhc3M9ImZyZXNoLWRvdCI+PC9zcGFuPgogICAgICA8c3BhbiBpZD0iZnJlc2gtYmFkZ2UtdGV4dCI+QWN0dWFsaXphbmRv4oCmPC9zcGFuPgogICAgPC9kaXY+CiAgICA8c3BhbiBjbGFzcz0idGFnLW1lcmNhZG8gY2xvc2VkIiBpZD0idGFnLW1lcmNhZG8iPk1lcmNhZG8gY2VycmFkbzwvc3Bhbj4KICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tdGFzYXMiIGlkPSJidG5UYXNhcyIgb25jbGljaz0idG9nZ2xlRHJhd2VyKCkiPgogICAgICDwn5OKIDxzcGFuIGNsYXNzPSJsYWJlbC1sb25nIj5Gb25kb3MgQ29tdW5lcyBkZSBJbnZlcnNpw7NuPC9zcGFuPgogICAgPC9idXR0b24+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLWFsZXJ0Ij7wn5SUIEFsZXJ0YXM8L2J1dHRvbj4KICA8L2Rpdj4KPC9oZWFkZXI+Cgo8IS0tIOKUgOKUgCBPVkVSTEFZIChtb2JpbGUpIOKUgOKUgCAtLT4KPGRpdiBjbGFzcz0ib3ZlcmxheSIgaWQ9Im92ZXJsYXkiIG9uY2xpY2s9InRvZ2dsZURyYXdlcigpIj48L2Rpdj4KCjwhLS0g4pSA4pSAIEJPRFkgV1JBUCDilIDilIAgLS0+CjxkaXYgY2xhc3M9ImJvZHktd3JhcCIgaWQ9ImJvZHlXcmFwIj4KCiAgPCEtLSDilZDilZDilZDilZAgTUFJTiDilZDilZDilZDilZAgLS0+CiAgPGRpdiBjbGFzcz0ibWFpbi1jb250ZW50Ij4KCiAgICA8IS0tIFNUQVRVUyBCQU5ORVIgLS0+CiAgICA8ZGl2IGNsYXNzPSJzdGF0dXMtYmFubmVyIHNpbWlsYXIiIGlkPSJzdGF0dXMtYmFubmVyIj4KICAgICAgPGRpdiBjbGFzcz0icy1sZWZ0Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJzLXRpdGxlIj4KICAgICAgICAgIDxzcGFuIGlkPSJzdGF0dXMtbGFiZWwiPk1FUCDiiYggQ0NMPC9zcGFuPgogICAgICAgICAgPHNwYW4gY2xhc3M9InMtYmFkZ2UiIGlkPSJzdGF0dXMtYmFkZ2UiPlNpbWlsYXI8L3NwYW4+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icy1zdWIiPkxhIGJyZWNoYSBlc3TDoSBkZW50cm8gZGVsIHVtYnJhbCDigJQgbG9zIHByZWNpb3Mgc29uIGNvbXBhcmFibGVzPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzLXJpZ2h0Ij4KICAgICAgICA8ZGl2PsOabHRpbWEgY29ycmlkYTogPHN0cm9uZyBpZD0ibGFzdC1ydW4tdGltZSI+4oCUPC9zdHJvbmc+PC9kaXY+CiAgICAgICAgPGRpdiBpZD0iY291bnRkb3duLXRleHQiPlByw7N4aW1hIGFjdHVhbGl6YWNpw7NuIGVuIDU6MDA8L2Rpdj4KICAgICAgICA8ZGl2PkNyb24gR01ULTMgwrcgTHVu4oCTVmllIDEwOjMw4oCTMTg6MDA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImVycm9yLWJhbm5lciIgaWQ9ImVycm9yLWJhbm5lciI+CiAgICAgIDxzcGFuIGlkPSJlcnJvci1iYW5uZXItdGV4dCI+RXJyb3IgYWwgYWN0dWFsaXphciDCtyBSZWludGVudGFyPC9zcGFuPgogICAgICA8YnV0dG9uIGlkPSJlcnJvci1yZXRyeS1idG4iIHR5cGU9ImJ1dHRvbiI+UmVpbnRlbnRhcjwvYnV0dG9uPgogICAgPC9kaXY+CgogICAgPCEtLSBIRVJPIENBUkRTIC0tPgogICAgPGRpdiBjbGFzcz0iaGVyby1ncmlkIj4KICAgICAgPGRpdiBjbGFzcz0iaGNhcmQgbWVwIj4KICAgICAgICA8ZGl2IGNsYXNzPSJiYXIiPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLWxhYmVsIj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJkb3QiPjwvc3Bhbj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0aXAiIGRhdGEtdD0iRMOzbGFyIEJvbHNhIOKAlCBjb21wcmEvdmVudGEgZGUgYm9ub3MgZW4gJEFSUyB5IFVTRCI+TUVQIHZlbnRhIOKTmDwvc3Bhbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC12YWwiIGlkPSJtZXAtdmFsIj4kMS4yNjQ8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC1zdWIiPmRvbGFyaXRvLmFyIMK3IHZlbnRhPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoY2FyZCBjY2wiPgogICAgICAgIDxkaXYgY2xhc3M9ImJhciI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtbGFiZWwiPgogICAgICAgICAgPHNwYW4gY2xhc3M9ImRvdCI+PC9zcGFuPgogICAgICAgICAgPHNwYW4gY2xhc3M9InRpcCIgZGF0YS10PSJDb250YWRvIGNvbiBMaXF1aWRhY2nDs24g4oCUIHNpbWlsYXIgYWwgTUVQIGNvbiBnaXJvIGFsIGV4dGVyaW9yIj5DQ0wgdmVudGEg4pOYPC9zcGFuPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLXZhbCIgaWQ9ImNjbC12YWwiPiQxLjI3MTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLXN1YiI+ZG9sYXJpdG8uYXIgwrcgdmVudGE8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImhjYXJkIGdhcCI+CiAgICAgICAgPGRpdiBjbGFzcz0iYmFyIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC1sYWJlbCI+CiAgICAgICAgICA8c3BhbiBjbGFzcz0iZG90Ij48L3NwYW4+CiAgICAgICAgICA8c3BhbiBjbGFzcz0idGlwIiBkYXRhLXQ9IkJyZWNoYSByZWxhdGl2YSBjb250cmEgZWwgcHJvbWVkaW8gZW50cmUgTUVQIHkgQ0NMIj5CcmVjaGEg4pOYPC9zcGFuPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLXZhbCIgaWQ9ImJyZWNoYS1hYnMiPiQ3PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtcGN0IiBpZD0iYnJlY2hhLXBjdCI+MC41NSU8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC1zdWIiPmRpZmVyZW5jaWEgYWJzb2x1dGEgwrcgcG9yY2VudHVhbDwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAgIDwhLS0gQ0hBUlQgLS0+CiAgICA8ZGl2IGNsYXNzPSJjaGFydC1jYXJkIj4KICAgICAgPGRpdiBjbGFzcz0iY2hhcnQtdG9wIj4KICAgICAgICA8ZGl2IGNsYXNzPSJjaGFydC10dGwiIGlkPSJ0cmVuZC10aXRsZSI+VGVuZGVuY2lhIE1FUC9DQ0wg4oCUIDEgZMOtYTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InBpbGxzIj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9InBpbGwgb24iIGRhdGEtZmlsdGVyPSIxZCI+MSBEw61hPC9idXR0b24+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJwaWxsIiBkYXRhLWZpbHRlcj0iMXciPjEgU2VtYW5hPC9idXR0b24+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJwaWxsIiBkYXRhLWZpbHRlcj0iMW0iPjEgTWVzPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJsZWdlbmRzIj4KICAgICAgICA8ZGl2IGNsYXNzPSJsZWciPjxkaXYgY2xhc3M9ImxlZy1saW5lIiBzdHlsZT0iYmFja2dyb3VuZDp2YXIoLS1tZXApIj48L2Rpdj5NRVA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJsZWciPjxkaXYgY2xhc3M9ImxlZy1saW5lIiBzdHlsZT0iYmFja2dyb3VuZDp2YXIoLS1jY2wpIj48L2Rpdj5DQ0w8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxzdmcgY2xhc3M9ImNoYXJ0IiBpZD0idHJlbmQtY2hhcnQiIHZpZXdCb3g9IjAgMCA4NjAgMTYwIiBwcmVzZXJ2ZUFzcGVjdFJhdGlvPSJub25lIj4KICAgICAgICA8bGluZSB4MT0iMCIgeTE9IjQwIiB4Mj0iODYwIiB5Mj0iNDAiIHN0cm9rZT0iIzFlMjUzMCIgc3Ryb2tlLXdpZHRoPSIxIi8+CiAgICAgICAgPGxpbmUgeDE9IjAiIHkxPSI4MCIgeDI9Ijg2MCIgeTI9IjgwIiBzdHJva2U9IiMxZTI1MzAiIHN0cm9rZS13aWR0aD0iMSIvPgogICAgICAgIDxsaW5lIHgxPSIwIiB5MT0iMTIwIiB4Mj0iODYwIiB5Mj0iMTIwIiBzdHJva2U9IiMxZTI1MzAiIHN0cm9rZS13aWR0aD0iMSIvPgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC15LXRvcCIgeD0iMiIgeT0iMzciIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iOCIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteS1taWQiIHg9IjIiIHk9Ijc3IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjgiIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXktbG93IiB4PSIyIiB5PSIxMTciIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iOCIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICA8cG9seWxpbmUgaWQ9InRyZW5kLW1lcC1saW5lIiBwb2ludHM9IiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMjliNmY2IiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz4KICAgICAgICA8cG9seWxpbmUgaWQ9InRyZW5kLWNjbC1saW5lIiBwb2ludHM9IiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjYjM5ZGRiIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz4KICAgICAgICA8bGluZSBpZD0idHJlbmQtaG92ZXItbGluZSIgeDE9IjAiIHkxPSIxOCIgeDI9IjAiIHkyPSIxMzIiIHN0cm9rZT0iIzJhMzQ0NCIgc3Ryb2tlLXdpZHRoPSIxIiBvcGFjaXR5PSIwIi8+CiAgICAgICAgPGNpcmNsZSBpZD0idHJlbmQtaG92ZXItbWVwIiBjeD0iMCIgY3k9IjAiIHI9IjMuNSIgZmlsbD0iIzI5YjZmNiIgb3BhY2l0eT0iMCIvPgogICAgICAgIDxjaXJjbGUgaWQ9InRyZW5kLWhvdmVyLWNjbCIgY3g9IjAiIGN5PSIwIiByPSIzLjUiIGZpbGw9IiNiMzlkZGIiIG9wYWNpdHk9IjAiLz4KICAgICAgICA8ZyBpZD0idHJlbmQtdG9vbHRpcCIgb3BhY2l0eT0iMCI+CiAgICAgICAgICA8cmVjdCBpZD0idHJlbmQtdG9vbHRpcC1iZyIgeD0iMCIgeT0iMCIgd2lkdGg9IjE0OCIgaGVpZ2h0PSI1NiIgcng9IjYiIGZpbGw9IiMxNjFiMjIiIHN0cm9rZT0iIzJhMzQ0NCIvPgogICAgICAgICAgPHRleHQgaWQ9InRyZW5kLXRpcC10aW1lIiB4PSIxMCIgeT0iMTQiIGZpbGw9IiM1NTYwNzAiIGZvbnQtc2l6ZT0iOCIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC10aXAtbWVwIiB4PSIxMCIgeT0iMjgiIGZpbGw9IiMyOWI2ZjYiIGZvbnQtc2l6ZT0iOSIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPk1FUCDigJQ8L3RleHQ+CiAgICAgICAgICA8dGV4dCBpZD0idHJlbmQtdGlwLWNjbCIgeD0iMTAiIHk9IjQwIiBmaWxsPSIjYjM5ZGRiIiBmb250LXNpemU9IjkiIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj5DQ0wg4oCUPC90ZXh0PgogICAgICAgICAgPHRleHQgaWQ9InRyZW5kLXRpcC1nYXAiIHg9IjEwIiB5PSI1MiIgZmlsbD0iI2ZmY2MwMCIgZm9udC1zaXplPSI4IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+QnJlY2hhIOKAlDwvdGV4dD4KICAgICAgICA8L2c+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXgtMSIgeD0iMjgiIHk9IjE1NCIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI3IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC14LTIiIHg9IjIxOCIgeT0iMTU0IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjciIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXgtMyIgeD0iNDE4IiB5PSIxNTQiIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iNyIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteC00IiB4PSI2MDgiIHk9IjE1NCIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI3IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC14LTUiIHg9Ijc5OCIgeT0iMTU0IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjciIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgIDwvc3ZnPgogICAgPC9kaXY+CgogICAgPCEtLSBNRVRSSUNTIC0tPgogICAgPGRpdiBjbGFzcz0ibWV0cmljcy1ncmlkIj4KICAgICAgPGRpdiBjbGFzcz0ibWNhcmQiPgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLWxhYmVsIiBpZD0ibWV0cmljLWNvdW50LWxhYmVsIj5NdWVzdHJhcyAxIGTDrWE8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC12YWwiIGlkPSJtZXRyaWMtY291bnQtMjRoIj7igJQ8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1zdWIiIGlkPSJtZXRyaWMtY291bnQtc3ViIj5yZWdpc3Ryb3MgZGVsIHBlcsOtb2RvIGZpbHRyYWRvPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJtY2FyZCI+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtbGFiZWwiIGlkPSJtZXRyaWMtc2ltaWxhci1sYWJlbCI+VmVjZXMgc2ltaWxhcjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXZhbCIgc3R5bGU9ImNvbG9yOnZhcigtLWdyZWVuKSIgaWQ9Im1ldHJpYy1zaW1pbGFyLTI0aCI+4oCUPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtc3ViIiBpZD0ibWV0cmljLXNpbWlsYXItc3ViIj5tb21lbnRvcyBlbiB6b25hIOKJpDElIG8g4omkJDEwPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJtY2FyZCI+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtbGFiZWwiIGlkPSJtZXRyaWMtbWluLWxhYmVsIj5CcmVjaGEgbcOtbi48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC12YWwiIGlkPSJtZXRyaWMtbWluLTI0aCI+4oCUPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtc3ViIiBpZD0ibWV0cmljLW1pbi1zdWIiPm3DrW5pbWEgZGVsIHBlcsOtb2RvIGZpbHRyYWRvPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJtY2FyZCI+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtbGFiZWwiIGlkPSJtZXRyaWMtbWF4LWxhYmVsIj5CcmVjaGEgbcOheC48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC12YWwiIHN0eWxlPSJjb2xvcjp2YXIoLS15ZWxsb3cpIiBpZD0ibWV0cmljLW1heC0yNGgiPuKAlDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXN1YiIgaWQ9Im1ldHJpYy1tYXgtc3ViIj5tw6F4aW1hIGRlbCBwZXLDrW9kbyBmaWx0cmFkbzwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAgIDwhLS0gVEFCTEUgLS0+CiAgICA8ZGl2IGNsYXNzPSJ0YWJsZS1jYXJkIj4KICAgICAgPGRpdiBjbGFzcz0idGFibGUtdG9wIj4KICAgICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS10dGwiPkhpc3RvcmlhbCBkZSByZWdpc3Ryb3M8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS1yaWdodCI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS1jYXAiIGlkPSJoaXN0b3J5LWNhcCI+w5psdGltYXMg4oCUIG11ZXN0cmFzPC9kaXY+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4tZG93bmxvYWQiIGlkPSJidG4tZG93bmxvYWQtY3N2IiB0eXBlPSJidXR0b24iIGFyaWEtbGFiZWw9IkRlc2NhcmdhciBDU1YiPgogICAgICAgICAgICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgYXJpYS1oaWRkZW49InRydWUiPgogICAgICAgICAgICAgIDxwYXRoIGQ9Ik0xMiA0djEwIj48L3BhdGg+CiAgICAgICAgICAgICAgPHBhdGggZD0iTTggMTBsNCA0IDQtNCI+PC9wYXRoPgogICAgICAgICAgICAgIDxwYXRoIGQ9Ik01IDE5aDE0Ij48L3BhdGg+CiAgICAgICAgICAgIDwvc3ZnPgogICAgICAgICAgICBEZXNjYXJnYXIgQ1NWCiAgICAgICAgICA8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Imhpc3RvcnktdGFibGUtd3JhcCI+CiAgICAgIDx0YWJsZSBpZD0iaGlzdG9yeS10YWJsZSI+CiAgICAgICAgPGNvbGdyb3VwIGlkPSJoaXN0b3J5LWNvbGdyb3VwIj4KICAgICAgICAgIDxjb2wgZGF0YS1jb2wtaW5kZXg9IjAiPgogICAgICAgICAgPGNvbCBkYXRhLWNvbC1pbmRleD0iMSI+CiAgICAgICAgICA8Y29sIGRhdGEtY29sLWluZGV4PSIyIj4KICAgICAgICAgIDxjb2wgZGF0YS1jb2wtaW5kZXg9IjMiPgogICAgICAgICAgPGNvbCBkYXRhLWNvbC1pbmRleD0iNCI+CiAgICAgICAgICA8Y29sIGRhdGEtY29sLWluZGV4PSI1Ij4KICAgICAgICA8L2NvbGdyb3VwPgogICAgICAgIDx0aGVhZD4KICAgICAgICAgIDx0cj4KICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJjb2wtbGFiZWwiPkTDrWEgLyBIb3JhPC9zcGFuPjxzcGFuIGNsYXNzPSJjb2wtcmVzaXplciIgZGF0YS1jb2wtaW5kZXg9IjAiIHJvbGU9InNlcGFyYXRvciIgYXJpYS1sYWJlbD0iQWp1c3RhciBhbmNobyBkZSBEw61hIC8gSG9yYSI+PC9zcGFuPjwvdGg+CiAgICAgICAgICAgIDx0aD48c3BhbiBjbGFzcz0iY29sLWxhYmVsIj5NRVA8L3NwYW4+PHNwYW4gY2xhc3M9ImNvbC1yZXNpemVyIiBkYXRhLWNvbC1pbmRleD0iMSIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIE1FUCI+PC9zcGFuPjwvdGg+CiAgICAgICAgICAgIDx0aD48c3BhbiBjbGFzcz0iY29sLWxhYmVsIj5DQ0w8L3NwYW4+PHNwYW4gY2xhc3M9ImNvbC1yZXNpemVyIiBkYXRhLWNvbC1pbmRleD0iMiIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIENDTCI+PC9zcGFuPjwvdGg+CiAgICAgICAgICAgIDx0aD48c3BhbiBjbGFzcz0iY29sLWxhYmVsIj5EaWYgJDwvc3Bhbj48c3BhbiBjbGFzcz0iY29sLXJlc2l6ZXIiIGRhdGEtY29sLWluZGV4PSIzIiByb2xlPSJzZXBhcmF0b3IiIGFyaWEtbGFiZWw9IkFqdXN0YXIgYW5jaG8gZGUgRGlmICQiPjwvc3Bhbj48L3RoPgogICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9ImNvbC1sYWJlbCI+RGlmICU8L3NwYW4+PHNwYW4gY2xhc3M9ImNvbC1yZXNpemVyIiBkYXRhLWNvbC1pbmRleD0iNCIgcm9sZT0ic2VwYXJhdG9yIiBhcmlhLWxhYmVsPSJBanVzdGFyIGFuY2hvIGRlIERpZiAlIj48L3NwYW4+PC90aD4KICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJjb2wtbGFiZWwiPkVzdGFkbzwvc3Bhbj48c3BhbiBjbGFzcz0iY29sLXJlc2l6ZXIiIGRhdGEtY29sLWluZGV4PSI1IiByb2xlPSJzZXBhcmF0b3IiIGFyaWEtbGFiZWw9IkFqdXN0YXIgYW5jaG8gZGUgRXN0YWRvIj48L3NwYW4+PC90aD4KICAgICAgICAgIDwvdHI+CiAgICAgICAgPC90aGVhZD4KICAgICAgICA8dGJvZHkgaWQ9Imhpc3Rvcnktcm93cyI+PC90Ym9keT4KICAgICAgPC90YWJsZT4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8IS0tIEdMT1NBUklPIC0tPgogICAgPGRpdiBjbGFzcz0iZ2xvc2FyaW8iPgogICAgICA8YnV0dG9uIGNsYXNzPSJnbG9zLWJ0biIgb25jbGljaz0idG9nZ2xlR2xvcyh0aGlzKSI+CiAgICAgICAgPHNwYW4+8J+TliBHbG9zYXJpbyBkZSB0w6lybWlub3M8L3NwYW4+CiAgICAgICAgPHNwYW4gaWQ9Imdsb3NBcnJvdyI+4pa+PC9zcGFuPgogICAgICA8L2J1dHRvbj4KICAgICAgPGRpdiBjbGFzcz0iZ2xvcy1ncmlkIiBpZD0iZ2xvc0dyaWQiPgogICAgICAgIDxkaXYgY2xhc3M9ImdpIj48ZGl2IGNsYXNzPSJnaS10ZXJtIj5NRVAgdmVudGE8L2Rpdj48ZGl2IGNsYXNzPSJnaS1kZWYiPlByZWNpbyBkZSB2ZW50YSBkZWwgZMOzbGFyIE1FUCAoTWVyY2FkbyBFbGVjdHLDs25pY28gZGUgUGFnb3MpIHbDrWEgY29tcHJhL3ZlbnRhIGRlIGJvbm9zIGVuICRBUlMgeSBVU0QuPC9kaXY+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZ2kiPjxkaXYgY2xhc3M9ImdpLXRlcm0iPkNDTCB2ZW50YTwvZGl2PjxkaXYgY2xhc3M9ImdpLWRlZiI+Q29udGFkbyBjb24gTGlxdWlkYWNpw7NuIOKAlCBzaW1pbGFyIGFsIE1FUCBwZXJvIHBlcm1pdGUgdHJhbnNmZXJpciBmb25kb3MgYWwgZXh0ZXJpb3IuIFN1ZWxlIGNvdGl6YXIgbGV2ZW1lbnRlIHBvciBlbmNpbWEuPC9kaXY+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZ2kiPjxkaXYgY2xhc3M9ImdpLXRlcm0iPkRpZmVyZW5jaWEgJTwvZGl2PjxkaXYgY2xhc3M9ImdpLWRlZiI+QnJlY2hhIHJlbGF0aXZhIGNhbGN1bGFkYSBjb250cmEgZWwgcHJvbWVkaW8gZW50cmUgTUVQIHkgQ0NMLiBVbWJyYWwgU0lNSUxBUjog4omkIDElIG8g4omkICQxMCBBUlMuPC9kaXY+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZ2kiPjxkaXYgY2xhc3M9ImdpLXRlcm0iPkZyZXNjdXJhIGRlbCBkYXRvPC9kaXY+PGRpdiBjbGFzcz0iZ2ktZGVmIj5UaWVtcG8gZGVzZGUgZWwgw7psdGltbyB0aW1lc3RhbXAgZGUgZG9sYXJpdG8uYXIuIEVsIGNyb24gY29ycmUgY2FkYSA1IG1pbiBlbiBkw61hcyBow6FiaWxlcy48L2Rpdj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJnaSI+PGRpdiBjbGFzcz0iZ2ktdGVybSI+RXN0YWRvIFNJTUlMQVI8L2Rpdj48ZGl2IGNsYXNzPSJnaS1kZWYiPkN1YW5kbyBNRVAgeSBDQ0wgZXN0w6FuIGRlbnRybyBkZWwgdW1icmFsIOKAlCBtb21lbnRvIGlkZWFsIHBhcmEgb3BlcmFyIGJ1c2NhbmRvIHBhcmlkYWQgZW50cmUgYW1ib3MgdGlwb3MuPC9kaXY+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZ2kiPjxkaXYgY2xhc3M9ImdpLXRlcm0iPk1lcmNhZG8gQVJHPC9kaXY+PGRpdiBjbGFzcz0iZ2ktZGVmIj5WZW50YW5hIG9wZXJhdGl2YTogbHVuZXMgYSB2aWVybmVzIGRlIDEwOjMwIGEgMTc6NTkgKEdNVC0zLCBCdWVub3MgQWlyZXMpLjwvZGl2PjwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAgIDxmb290ZXI+CiAgICAgIEZ1ZW50ZTogPGEgaHJlZj0iIyI+ZG9sYXJpdG8uYXI8L2E+IMK3IDxhIGhyZWY9IiMiPmFyZ2VudGluYWRhdG9zLmNvbTwvYT4gwrcgRGF0b3MgY2FkYSA1IG1pbiBlbiBkw61hcyBow6FiaWxlcyDCtyA8YSBocmVmPSIjIj5SZXBvcnRhciBwcm9ibGVtYTwvYT4KICAgIDwvZm9vdGVyPgoKICA8L2Rpdj48IS0tIC9tYWluLWNvbnRlbnQgLS0+CgogIDwhLS0g4pWQ4pWQ4pWQ4pWQIERSQVdFUiDilZDilZDilZDilZAgLS0+CiAgPGRpdiBjbGFzcz0iZHJhd2VyIiBpZD0iZHJhd2VyIj4KICAgIDxkaXYgY2xhc3M9ImRyYXdlci1yZXNpemVyIiBpZD0iZHJhd2VyLXJlc2l6ZXIiIGFyaWEtaGlkZGVuPSJ0cnVlIj48L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJkcmF3ZXItaGVhZGVyIj4KICAgICAgPGRpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJkcmF3ZXItdGl0bGUiPvCfk4ogRm9uZG9zIENvbXVuZXMgZGUgSW52ZXJzacOzbjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImRyYXdlci1zb3VyY2UiPkZ1ZW50ZXM6IGFyZ2VudGluYWRhdG9zLmNvbTwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuLWNsb3NlIiBvbmNsaWNrPSJ0b2dnbGVEcmF3ZXIoKSI+4pyVPC9idXR0b24+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJkcmF3ZXItYm9keSI+CiAgICAgIDxkaXYgY2xhc3M9ImZjaS1oZWFkZXIiPgogICAgICAgIDxkaXYgY2xhc3M9ImZjaS10aXRsZSI+UmVudGEgZmlqYSAoRkNJIEFyZ2VudGluYSk8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmY2ktbWV0YSIgaWQ9ImZjaS1sYXN0LWRhdGUiPkZlY2hhOiDigJQ8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZjaS1jb250cm9scyI+CiAgICAgICAgPGlucHV0IGlkPSJmY2ktc2VhcmNoIiBjbGFzcz0iZmNpLXNlYXJjaCIgdHlwZT0idGV4dCIgcGxhY2Vob2xkZXI9IkJ1c2NhciBmb25kby4uLiIgLz4KICAgICAgICA8ZGl2IGNsYXNzPSJmY2ktcGFnaW5hdGlvbiI+CiAgICAgICAgICA8YnV0dG9uIGlkPSJmY2ktcHJldiIgY2xhc3M9ImZjaS1wYWdlLWJ0biIgdHlwZT0iYnV0dG9uIj7il4A8L2J1dHRvbj4KICAgICAgICAgIDxkaXYgaWQ9ImZjaS1wYWdlLWluZm8iIGNsYXNzPSJmY2ktcGFnZS1pbmZvIj4xIC8gMTwvZGl2PgogICAgICAgICAgPGJ1dHRvbiBpZD0iZmNpLW5leHQiIGNsYXNzPSJmY2ktcGFnZS1idG4iIHR5cGU9ImJ1dHRvbiI+4pa2PC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmY2ktdGFibGUtd3JhcCI+CiAgICAgICAgPHRhYmxlIGNsYXNzPSJmY2ktdGFibGUiPgogICAgICAgICAgPHRoZWFkPgogICAgICAgICAgICA8dHI+CiAgICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJ0aXAgdGlwLWRvd24iIGRhdGEtdD0iTm9tYnJlIGRlbCBGb25kbyBDb23Dum4gZGUgSW52ZXJzacOzbi4iPkZvbmRvIOKTmDwvc3Bhbj48L3RoPgogICAgICAgICAgICAgIDx0aD48c3BhbiBjbGFzcz0idGlwIHRpcC1kb3duIiBkYXRhLXQ9IlZDUCDigJQgVmFsb3IgQ3VvdGFwYXJ0ZS4gUHJlY2lvIHVuaXRhcmlvIGRlIGNhZGEgY3VvdGFwYXJ0ZS4gVXNhbG8gcGFyYSBjb21wYXJhciByZW5kaW1pZW50byBlbnRyZSBmZWNoYXMuIj5WQ1Ag4pOYPC9zcGFuPjwvdGg+CiAgICAgICAgICAgICAgPHRoPjxzcGFuIGNsYXNzPSJ0aXAgdGlwLWRvd24iIGRhdGEtdD0iQ0NQIOKAlCBDYW50aWRhZCBkZSBDdW90YXBhcnRlcy4gVG90YWwgZGUgY3VvdGFwYXJ0ZXMgZW1pdGlkYXMuIFN1YmUgY3VhbmRvIGVudHJhbiBpbnZlcnNvcmVzLCBiYWphIGN1YW5kbyByZXNjYXRhbi4iPkNDUCDik5g8L3NwYW4+PC90aD4KICAgICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9InRpcCB0aXAtZG93biIgZGF0YS10PSJQYXRyaW1vbmlvIOKAlCBWQ1Agw5cgQ0NQLiBWYWxvciB0b3RhbCBhZG1pbmlzdHJhZG8gcG9yIGVsIGZvbmRvIGVuIHBlc29zIGEgZXNhIGZlY2hhLiI+UGF0cmltb25pbyDik5g8L3NwYW4+PC90aD4KICAgICAgICAgICAgICA8dGg+PHNwYW4gY2xhc3M9InRpcCB0aXAtZG93biIgZGF0YS10PSJIb3Jpem9udGUgZGUgaW52ZXJzacOzbiBzdWdlcmlkbyAoY29ydG8sIG1lZGlvIG8gbGFyZ28pLiI+SG9yaXpvbnRlIOKTmDwvc3Bhbj48L3RoPgogICAgICAgICAgICA8L3RyPgogICAgICAgICAgPC90aGVhZD4KICAgICAgICAgIDx0Ym9keSBpZD0iZmNpLXJvd3MiPgogICAgICAgICAgICA8dHI+PHRkIGNvbHNwYW49IjUiIGNsYXNzPSJkaW0iPkNhcmdhbmRv4oCmPC90ZD48L3RyPgogICAgICAgICAgPC90Ym9keT4KICAgICAgICA8L3RhYmxlPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmNpLWVtcHR5IiBpZD0iZmNpLWVtcHR5IiBzdHlsZT0iZGlzcGxheTpub25lIj4KICAgICAgICBObyBoYXkgZGF0b3MgZGUgcmVudGEgZmlqYSBkaXNwb25pYmxlcyBlbiBlc3RlIG1vbWVudG8uCiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJjb250ZXh0LWJveCI+CiAgICAgICAgPHN0cm9uZz5UaXA6PC9zdHJvbmc+PGJyPgogICAgICAgIFNlIGxpc3RhbiBsb3MgZm9uZG9zIGRlIHJlbnRhIGZpamEgb3JkZW5hZG9zIHBvciBwYXRyaW1vbmlvIChkZSBtYXlvciBhIG1lbm9yKS48YnI+CiAgICAgICAgPHNwYW4gc3R5bGU9ImNvbG9yOnZhcigtLWdyZWVuKSI+4payPC9zcGFuPiBzdWJlIHZzIGTDrWEgYW50ZXJpb3IgwrcgPHNwYW4gc3R5bGU9ImNvbG9yOnZhcigtLXJlZCkiPuKWvDwvc3Bhbj4gYmFqYSB2cyBkw61hIGFudGVyaW9yIMK3IDxzcGFuIHN0eWxlPSJjb2xvcjp2YXIoLS1tdXRlZDIpIj49PC9zcGFuPiBzaW4gY2FtYmlvcwogICAgICA8L2Rpdj4KICAgIDwvZGl2PjwhLS0gL2RyYXdlci1ib2R5IC0tPgogIDwvZGl2PjwhLS0gL2RyYXdlciAtLT4KCjwvZGl2PjwhLS0gL2JvZHktd3JhcCAtLT4KPC9kaXY+PCEtLSAvYXBwIC0tPgo8ZGl2IGNsYXNzPSJzbWFydC10aXAiIGlkPSJzbWFydC10aXAiIHJvbGU9InRvb2x0aXAiIGFyaWEtaGlkZGVuPSJ0cnVlIj48L2Rpdj4KCjxzY3JpcHQ+CiAgLy8gMSkgQ29uc3RhbnRlcyB5IGNvbmZpZ3VyYWNpw7NuCiAgY29uc3QgRU5EUE9JTlRTID0gewogICAgbWVwQ2NsOiAnL2FwaS9kYXRhJywKICAgIGZjaVJlbnRhRmlqYTogJ2h0dHBzOi8vYXBpLmFyZ2VudGluYWRhdG9zLmNvbS92MS9maW5hbnphcy9mY2kvcmVudGFGaWphL3VsdGltbycsCiAgICBmY2lSZW50YUZpamFQZW51bHRpbW86ICdodHRwczovL2FwaS5hcmdlbnRpbmFkYXRvcy5jb20vdjEvZmluYW56YXMvZmNpL3JlbnRhRmlqYS9wZW51bHRpbW8nCiAgfTsKICBjb25zdCBBUkdfVFogPSAnQW1lcmljYS9BcmdlbnRpbmEvQnVlbm9zX0FpcmVzJzsKICBjb25zdCBGRVRDSF9JTlRFUlZBTF9NUyA9IDMwMDAwMDsKICBjb25zdCBDQUNIRV9LRVkgPSAncmFkYXJfY2FjaGUnOwogIGNvbnN0IEhJU1RPUllfQ09MU19LRVkgPSAncmFkYXJfaGlzdG9yeV9jb2xfd2lkdGhzX3YxJzsKICBjb25zdCBEUkFXRVJfV0lEVEhfS0VZID0gJ3JhZGFyX2RyYXdlcl93aWR0aF92MSc7CiAgY29uc3QgQ0FDSEVfVFRMX01TID0gMTUgKiA2MCAqIDEwMDA7CiAgY29uc3QgUkVUUllfREVMQVlTID0gWzEwMDAwLCAzMDAwMCwgNjAwMDBdOwogIGNvbnN0IFNJTUlMQVJfUENUX1RIUkVTSE9MRCA9IDE7CiAgY29uc3QgU0lNSUxBUl9BUlNfVEhSRVNIT0xEID0gMTA7CiAgY29uc3QgVFJFTkRfTUFYX1BPSU5UUyA9IDI0MDsKICBjb25zdCBGQ0lfUEFHRV9TSVpFID0gMTA7CiAgY29uc3QgRFJBV0VSX01JTl9XID0gMzQwOwogIGNvbnN0IERSQVdFUl9NQVhfVyA9IDc2MDsKICBjb25zdCBISVNUT1JZX0RFRkFVTFRfQ09MX1dJRFRIUyA9IFsxNzAsIDE2MCwgMTYwLCAxMjAsIDEyMCwgMTcwXTsKICBjb25zdCBISVNUT1JZX01JTl9DT0xfV0lEVEhTID0gWzEyMCwgMTEwLCAxMTAsIDkwLCA5MCwgMTIwXTsKICBjb25zdCBOVU1FUklDX0lEUyA9IFsKICAgICdtZXAtdmFsJywgJ2NjbC12YWwnLCAnYnJlY2hhLWFicycsICdicmVjaGEtcGN0JwogIF07CiAgY29uc3Qgc3RhdGUgPSB7CiAgICByZXRyeUluZGV4OiAwLAogICAgcmV0cnlUaW1lcjogbnVsbCwKICAgIGxhc3RTdWNjZXNzQXQ6IDAsCiAgICBpc0ZldGNoaW5nOiBmYWxzZSwKICAgIGZpbHRlck1vZGU6ICcxZCcsCiAgICBsYXN0TWVwUGF5bG9hZDogbnVsbCwKICAgIHRyZW5kUm93czogW10sCiAgICB0cmVuZEhvdmVyQm91bmQ6IGZhbHNlLAogICAgaGlzdG9yeVJlc2l6ZUJvdW5kOiBmYWxzZSwKICAgIGhpc3RvcnlDb2xXaWR0aHM6IFtdLAogICAgc291cmNlVHNNczogbnVsbCwKICAgIGZyZXNoQmFkZ2VNb2RlOiAnaWRsZScsCiAgICBmcmVzaFRpY2tlcjogbnVsbCwKICAgIGZjaVJvd3M6IFtdLAogICAgZmNpUHJldmlvdXNCeUZvbmRvOiBuZXcgTWFwKCksCiAgICBmY2lRdWVyeTogJycsCiAgICBmY2lQYWdlOiAxLAogICAgc21hcnRUaXBCb3VuZDogZmFsc2UsCiAgICBkcmF3ZXJSZXNpemVCb3VuZDogZmFsc2UsCiAgICBsYXRlc3Q6IHsKICAgICAgbWVwOiBudWxsLAogICAgICBjY2w6IG51bGwsCiAgICAgIGJyZWNoYUFiczogbnVsbCwKICAgICAgYnJlY2hhUGN0OiBudWxsCiAgICB9CiAgfTsKCiAgLy8gMikgSGVscGVycwogIGNvbnN0IGZtdEFyZ1RpbWUgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZXMtQVInLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgaG91cjogJzItZGlnaXQnLAogICAgbWludXRlOiAnMi1kaWdpdCcKICB9KTsKICBjb25zdCBmbXRBcmdUaW1lU2VjID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VzLUFSJywgewogICAgdGltZVpvbmU6IEFSR19UWiwKICAgIGhvdXI6ICcyLWRpZ2l0JywKICAgIG1pbnV0ZTogJzItZGlnaXQnLAogICAgc2Vjb25kOiAnMi1kaWdpdCcKICB9KTsKICBjb25zdCBmbXRBcmdIb3VyID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VzLUFSJywgewogICAgdGltZVpvbmU6IEFSR19UWiwKICAgIGhvdXI6ICcyLWRpZ2l0JywKICAgIG1pbnV0ZTogJzItZGlnaXQnLAogICAgaG91cjEyOiBmYWxzZQogIH0pOwogIGNvbnN0IGZtdEFyZ0RheU1vbnRoID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VzLUFSJywgewogICAgdGltZVpvbmU6IEFSR19UWiwKICAgIGRheTogJzItZGlnaXQnLAogICAgbW9udGg6ICcyLWRpZ2l0JwogIH0pOwogIGNvbnN0IGZtdEFyZ0RhdGUgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZW4tQ0EnLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgeWVhcjogJ251bWVyaWMnLAogICAgbW9udGg6ICcyLWRpZ2l0JywKICAgIGRheTogJzItZGlnaXQnCiAgfSk7CiAgY29uc3QgZm10QXJnV2Vla2RheSA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlbi1VUycsIHsKICAgIHRpbWVab25lOiBBUkdfVFosCiAgICB3ZWVrZGF5OiAnc2hvcnQnCiAgfSk7CiAgY29uc3QgZm10QXJnUGFydHMgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZW4tVVMnLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgd2Vla2RheTogJ3Nob3J0JywKICAgIGhvdXI6ICcyLWRpZ2l0JywKICAgIG1pbnV0ZTogJzItZGlnaXQnLAogICAgc2Vjb25kOiAnMi1kaWdpdCcsCiAgICBob3VyMTI6IGZhbHNlCiAgfSk7CiAgY29uc3QgV0VFS0RBWSA9IHsgTW9uOiAxLCBUdWU6IDIsIFdlZDogMywgVGh1OiA0LCBGcmk6IDUsIFNhdDogNiwgU3VuOiA3IH07CgogIGZ1bmN0aW9uIHRvTnVtYmVyKHZhbHVlKSB7CiAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpKSByZXR1cm4gdmFsdWU7CiAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykgewogICAgICBjb25zdCBub3JtYWxpemVkID0gdmFsdWUucmVwbGFjZSgvXHMvZywgJycpLnJlcGxhY2UoJywnLCAnLicpLnJlcGxhY2UoL1teXGQuLV0vZywgJycpOwogICAgICBjb25zdCBwYXJzZWQgPSBOdW1iZXIobm9ybWFsaXplZCk7CiAgICAgIHJldHVybiBOdW1iZXIuaXNGaW5pdGUocGFyc2VkKSA/IHBhcnNlZCA6IG51bGw7CiAgICB9CiAgICByZXR1cm4gbnVsbDsKICB9CiAgZnVuY3Rpb24gZ2V0UGF0aChvYmosIHBhdGgpIHsKICAgIHJldHVybiBwYXRoLnJlZHVjZSgoYWNjLCBrZXkpID0+IChhY2MgJiYgYWNjW2tleV0gIT09IHVuZGVmaW5lZCA/IGFjY1trZXldIDogdW5kZWZpbmVkKSwgb2JqKTsKICB9CiAgZnVuY3Rpb24gcGlja051bWJlcihvYmosIHBhdGhzKSB7CiAgICBmb3IgKGNvbnN0IHBhdGggb2YgcGF0aHMpIHsKICAgICAgY29uc3QgdiA9IGdldFBhdGgob2JqLCBwYXRoKTsKICAgICAgY29uc3QgbiA9IHRvTnVtYmVyKHYpOwogICAgICBpZiAobiAhPT0gbnVsbCkgcmV0dXJuIG47CiAgICB9CiAgICByZXR1cm4gbnVsbDsKICB9CiAgZnVuY3Rpb24gcGlja0J5S2V5SGludChvYmosIGhpbnQpIHsKICAgIGlmICghb2JqIHx8IHR5cGVvZiBvYmogIT09ICdvYmplY3QnKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGxvd2VyID0gaGludC50b0xvd2VyQ2FzZSgpOwogICAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXMob2JqKSkgewogICAgICBpZiAoay50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKGxvd2VyKSkgewogICAgICAgIGNvbnN0IG4gPSB0b051bWJlcih2KTsKICAgICAgICBpZiAobiAhPT0gbnVsbCkgcmV0dXJuIG47CiAgICAgICAgaWYgKHYgJiYgdHlwZW9mIHYgPT09ICdvYmplY3QnKSB7CiAgICAgICAgICBjb25zdCBkZWVwID0gcGlja0J5S2V5SGludCh2LCBoaW50KTsKICAgICAgICAgIGlmIChkZWVwICE9PSBudWxsKSByZXR1cm4gZGVlcDsKICAgICAgICB9CiAgICAgIH0KICAgICAgaWYgKHYgJiYgdHlwZW9mIHYgPT09ICdvYmplY3QnKSB7CiAgICAgICAgY29uc3QgZGVlcCA9IHBpY2tCeUtleUhpbnQodiwgaGludCk7CiAgICAgICAgaWYgKGRlZXAgIT09IG51bGwpIHJldHVybiBkZWVwOwogICAgICB9CiAgICB9CiAgICByZXR1cm4gbnVsbDsKICB9CiAgZnVuY3Rpb24gZ2V0QXJnTm93UGFydHMoZGF0ZSA9IG5ldyBEYXRlKCkpIHsKICAgIGNvbnN0IHBhcnRzID0gZm10QXJnUGFydHMuZm9ybWF0VG9QYXJ0cyhkYXRlKS5yZWR1Y2UoKGFjYywgcCkgPT4gewogICAgICBhY2NbcC50eXBlXSA9IHAudmFsdWU7CiAgICAgIHJldHVybiBhY2M7CiAgICB9LCB7fSk7CiAgICByZXR1cm4gewogICAgICB3ZWVrZGF5OiBXRUVLREFZW3BhcnRzLndlZWtkYXldIHx8IDAsCiAgICAgIGhvdXI6IE51bWJlcihwYXJ0cy5ob3VyIHx8ICcwJyksCiAgICAgIG1pbnV0ZTogTnVtYmVyKHBhcnRzLm1pbnV0ZSB8fCAnMCcpLAogICAgICBzZWNvbmQ6IE51bWJlcihwYXJ0cy5zZWNvbmQgfHwgJzAnKQogICAgfTsKICB9CiAgZnVuY3Rpb24gYnJlY2hhUGVyY2VudChtZXAsIGNjbCkgewogICAgaWYgKG1lcCA9PT0gbnVsbCB8fCBjY2wgPT09IG51bGwpIHJldHVybiBudWxsOwogICAgY29uc3QgYXZnID0gKG1lcCArIGNjbCkgLyAyOwogICAgaWYgKCFhdmcpIHJldHVybiBudWxsOwogICAgcmV0dXJuIChNYXRoLmFicyhtZXAgLSBjY2wpIC8gYXZnKSAqIDEwMDsKICB9CiAgZnVuY3Rpb24gZm9ybWF0TW9uZXkodmFsdWUsIGRpZ2l0cyA9IDApIHsKICAgIGlmICh2YWx1ZSA9PT0gbnVsbCkgcmV0dXJuICfigJQnOwogICAgcmV0dXJuICckJyArIHZhbHVlLnRvTG9jYWxlU3RyaW5nKCdlcy1BUicsIHsKICAgICAgbWluaW11bUZyYWN0aW9uRGlnaXRzOiBkaWdpdHMsCiAgICAgIG1heGltdW1GcmFjdGlvbkRpZ2l0czogZGlnaXRzCiAgICB9KTsKICB9CiAgZnVuY3Rpb24gZm9ybWF0UGVyY2VudCh2YWx1ZSwgZGlnaXRzID0gMikgewogICAgaWYgKHZhbHVlID09PSBudWxsKSByZXR1cm4gJ+KAlCc7CiAgICByZXR1cm4gdmFsdWUudG9GaXhlZChkaWdpdHMpICsgJyUnOwogIH0KICBmdW5jdGlvbiBmb3JtYXRDb21wYWN0TW9uZXkodmFsdWUsIGRpZ2l0cyA9IDIpIHsKICAgIGlmICh2YWx1ZSA9PT0gbnVsbCkgcmV0dXJuICfigJQnOwogICAgcmV0dXJuIHZhbHVlLnRvTG9jYWxlU3RyaW5nKCdlcy1BUicsIHsKICAgICAgbWluaW11bUZyYWN0aW9uRGlnaXRzOiBkaWdpdHMsCiAgICAgIG1heGltdW1GcmFjdGlvbkRpZ2l0czogZGlnaXRzCiAgICB9KTsKICB9CiAgZnVuY3Rpb24gZXNjYXBlSHRtbCh2YWx1ZSkgewogICAgcmV0dXJuIFN0cmluZyh2YWx1ZSA/PyAnJykucmVwbGFjZSgvWyY8PiInXS9nLCAoY2hhcikgPT4gKAogICAgICB7ICcmJzogJyZhbXA7JywgJzwnOiAnJmx0OycsICc+JzogJyZndDsnLCAnIic6ICcmcXVvdDsnLCAiJyI6ICcmIzM5OycgfVtjaGFyXQogICAgKSk7CiAgfQogIGZ1bmN0aW9uIHNldFRleHQoaWQsIHRleHQsIG9wdGlvbnMgPSB7fSkgewogICAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7CiAgICBpZiAoIWVsKSByZXR1cm47CiAgICBjb25zdCBuZXh0ID0gU3RyaW5nKHRleHQpOwogICAgY29uc3QgcHJldiA9IGVsLnRleHRDb250ZW50OwogICAgZWwudGV4dENvbnRlbnQgPSBuZXh0OwogICAgZWwuY2xhc3NMaXN0LnJlbW92ZSgnc2tlbGV0b24nKTsKICAgIGlmIChvcHRpb25zLmNoYW5nZUNsYXNzICYmIHByZXYgIT09IG5leHQpIHsKICAgICAgZWwuY2xhc3NMaXN0LmFkZCgndmFsdWUtY2hhbmdlZCcpOwogICAgICBzZXRUaW1lb3V0KCgpID0+IGVsLmNsYXNzTGlzdC5yZW1vdmUoJ3ZhbHVlLWNoYW5nZWQnKSwgNjAwKTsKICAgIH0KICB9CiAgZnVuY3Rpb24gc2V0RGFzaChpZHMpIHsKICAgIGlkcy5mb3JFYWNoKChpZCkgPT4gc2V0VGV4dChpZCwgJ+KAlCcpKTsKICB9CiAgZnVuY3Rpb24gc2V0TG9hZGluZyhpZHMsIGlzTG9hZGluZykgewogICAgaWRzLmZvckVhY2goKGlkKSA9PiB7CiAgICAgIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpOwogICAgICBpZiAoIWVsKSByZXR1cm47CiAgICAgIGVsLmNsYXNzTGlzdC50b2dnbGUoJ3NrZWxldG9uJywgaXNMb2FkaW5nKTsKICAgIH0pOwogIH0KICBmdW5jdGlvbiBzZXRGcmVzaEJhZGdlKHRleHQsIG1vZGUpIHsKICAgIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZyZXNoLWJhZGdlJyk7CiAgICBjb25zdCBsYWJlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmcmVzaC1iYWRnZS10ZXh0Jyk7CiAgICBpZiAoIWJhZGdlIHx8ICFsYWJlbCkgcmV0dXJuOwogICAgbGFiZWwudGV4dENvbnRlbnQgPSB0ZXh0OwogICAgc3RhdGUuZnJlc2hCYWRnZU1vZGUgPSBtb2RlIHx8ICdpZGxlJzsKICAgIGJhZGdlLmNsYXNzTGlzdC50b2dnbGUoJ2ZldGNoaW5nJywgbW9kZSA9PT0gJ2ZldGNoaW5nJyk7CiAgICBiYWRnZS5jbGFzc0xpc3QudG9nZ2xlKCdlcnJvcicsIG1vZGUgPT09ICdlcnJvcicpOwogICAgYmFkZ2Uub25jbGljayA9IG1vZGUgPT09ICdlcnJvcicgPyAoKSA9PiBmZXRjaEFsbCh7IG1hbnVhbDogdHJ1ZSB9KSA6IG51bGw7CiAgfQogIGZ1bmN0aW9uIGZvcm1hdFNvdXJjZUFnZUxhYmVsKHRzTXMpIHsKICAgIGxldCBuID0gdG9OdW1iZXIodHNNcyk7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShuKSkgcmV0dXJuIG51bGw7CiAgICBpZiAobiA8IDFlMTIpIG4gKj0gMTAwMDsKICAgIGNvbnN0IGFnZU1pbiA9IE1hdGgubWF4KDAsIE1hdGguZmxvb3IoKERhdGUubm93KCkgLSBuKSAvIDYwMDAwKSk7CiAgICBpZiAoYWdlTWluIDwgNjApIHJldHVybiBgJHthZ2VNaW59IG1pbmA7CiAgICBjb25zdCBoID0gTWF0aC5mbG9vcihhZ2VNaW4gLyA2MCk7CiAgICBjb25zdCBtID0gYWdlTWluICUgNjA7CiAgICByZXR1cm4gbSA9PT0gMCA/IGAke2h9IGhgIDogYCR7aH0gaCAke219IG1pbmA7CiAgfQogIGZ1bmN0aW9uIHJlZnJlc2hGcmVzaEJhZGdlRnJvbVNvdXJjZSgpIHsKICAgIGlmIChzdGF0ZS5mcmVzaEJhZGdlTW9kZSA9PT0gJ2ZldGNoaW5nJyB8fCBzdGF0ZS5mcmVzaEJhZGdlTW9kZSA9PT0gJ2Vycm9yJykgcmV0dXJuOwogICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoc3RhdGUuc291cmNlVHNNcykpIHJldHVybjsKICAgIGNvbnN0IGFnZUxhYmVsID0gZm9ybWF0U291cmNlQWdlTGFiZWwoc3RhdGUuc291cmNlVHNNcyk7CiAgICBpZiAoIWFnZUxhYmVsKSByZXR1cm47CiAgICBzZXRGcmVzaEJhZGdlKGDDmmx0aW1hIGFjdHVhbGl6YWNpw7NuIGhhY2U6ICR7YWdlTGFiZWx9YCwgJ2lkbGUnKTsKICB9CiAgZnVuY3Rpb24gc3RhcnRGcmVzaFRpY2tlcigpIHsKICAgIGlmIChzdGF0ZS5mcmVzaFRpY2tlcikgcmV0dXJuOwogICAgc3RhdGUuZnJlc2hUaWNrZXIgPSBzZXRJbnRlcnZhbChyZWZyZXNoRnJlc2hCYWRnZUZyb21Tb3VyY2UsIDMwMDAwKTsKICB9CiAgZnVuY3Rpb24gc2V0TWFya2V0VGFnKGlzT3BlbikgewogICAgY29uc3QgdGFnID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RhZy1tZXJjYWRvJyk7CiAgICBpZiAoIXRhZykgcmV0dXJuOwogICAgdGFnLnRleHRDb250ZW50ID0gaXNPcGVuID8gJ01lcmNhZG8gYWJpZXJ0bycgOiAnTWVyY2FkbyBjZXJyYWRvJzsKICAgIHRhZy5jbGFzc0xpc3QudG9nZ2xlKCdjbG9zZWQnLCAhaXNPcGVuKTsKICB9CiAgZnVuY3Rpb24gc2V0RXJyb3JCYW5uZXIoc2hvdywgdGV4dCkgewogICAgY29uc3QgYmFubmVyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Vycm9yLWJhbm5lcicpOwogICAgY29uc3QgbGFiZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZXJyb3ItYmFubmVyLXRleHQnKTsKICAgIGlmICghYmFubmVyKSByZXR1cm47CiAgICBpZiAodGV4dCAmJiBsYWJlbCkgbGFiZWwudGV4dENvbnRlbnQgPSB0ZXh0OwogICAgYmFubmVyLmNsYXNzTGlzdC50b2dnbGUoJ3Nob3cnLCAhIXNob3cpOwogIH0KICBmdW5jdGlvbiBleHRyYWN0Um9vdChqc29uKSB7CiAgICByZXR1cm4ganNvbiAmJiB0eXBlb2YganNvbiA9PT0gJ29iamVjdCcgPyAoanNvbi5kYXRhIHx8IGpzb24ucmVzdWx0IHx8IGpzb24pIDoge307CiAgfQogIGZ1bmN0aW9uIG5vcm1hbGl6ZUZjaVJvd3MocGF5bG9hZCkgewogICAgY29uc3Qgcm9vdCA9IGV4dHJhY3RSb290KHBheWxvYWQpOwogICAgaWYgKEFycmF5LmlzQXJyYXkocm9vdCkpIHJldHVybiByb290OwogICAgaWYgKEFycmF5LmlzQXJyYXkocm9vdD8uaXRlbXMpKSByZXR1cm4gcm9vdC5pdGVtczsKICAgIGlmIChBcnJheS5pc0FycmF5KHJvb3Q/LnJvd3MpKSByZXR1cm4gcm9vdC5yb3dzOwogICAgcmV0dXJuIFtdOwogIH0KICBmdW5jdGlvbiBub3JtYWxpemVGY2lGb25kb0tleSh2YWx1ZSkgewogICAgcmV0dXJuIFN0cmluZyh2YWx1ZSB8fCAnJykKICAgICAgLnRvTG93ZXJDYXNlKCkKICAgICAgLm5vcm1hbGl6ZSgnTkZEJykKICAgICAgLnJlcGxhY2UoL1tcdTAzMDAtXHUwMzZmXS9nLCAnJykKICAgICAgLnJlcGxhY2UoL1xzKy9nLCAnICcpCiAgICAgIC50cmltKCk7CiAgfQogIGZ1bmN0aW9uIGZjaURpcmVjdGlvbihjdXJyZW50LCBwcmV2aW91cykgewogICAgY29uc3QgY3VyciA9IHRvTnVtYmVyKGN1cnJlbnQpOwogICAgY29uc3QgcHJldiA9IHRvTnVtYmVyKHByZXZpb3VzKTsKICAgIGlmIChjdXJyID09PSBudWxsIHx8IHByZXYgPT09IG51bGwpIHJldHVybiAnbmEnOwogICAgaWYgKE1hdGguYWJzKGN1cnIgLSBwcmV2KSA8IDFlLTkpIHJldHVybiAnZmxhdCc7CiAgICByZXR1cm4gY3VyciA+IHByZXYgPyAndXAnIDogJ2Rvd24nOwogIH0KICBmdW5jdGlvbiBmY2lEaXJlY3Rpb25MYWJlbChkaXIpIHsKICAgIGlmIChkaXIgPT09ICd1cCcpIHJldHVybiAnc3ViacOzJzsKICAgIGlmIChkaXIgPT09ICdkb3duJykgcmV0dXJuICdiYWrDsyc7CiAgICBpZiAoZGlyID09PSAnZmxhdCcpIHJldHVybiAnc2luIGNhbWJpb3MnOwogICAgcmV0dXJuICdzaW4gZGF0byBwcmV2aW8nOwogIH0KICBmdW5jdGlvbiByZW5kZXJGY2lWYWx1ZVdpdGhUcmVuZCh2YWx1ZSwgZGlyZWN0aW9uKSB7CiAgICBjb25zdCBzYWZlVmFsdWUgPSBmb3JtYXRDb21wYWN0TW9uZXkodmFsdWUsIDIpOwogICAgY29uc3QgZGlyID0gZGlyZWN0aW9uIHx8ICduYSc7CiAgICBjb25zdCBpY29uID0gZGlyID09PSAndXAnID8gJ+KWsicgOiBkaXIgPT09ICdkb3duJyA/ICfilrwnIDogZGlyID09PSAnZmxhdCcgPyAnPScgOiAnwrcnOwogICAgcmV0dXJuIGA8c3BhbiBjbGFzcz0iZmNpLWRlbHRhIGZjaS1kZWx0YS0ke2Rpcn0iIHRpdGxlPSIke2VzY2FwZUh0bWwoZmNpRGlyZWN0aW9uTGFiZWwoZGlyKSl9Ij48c3BhbiBjbGFzcz0iZmNpLWRlbHRhLWljb24iPiR7aWNvbn08L3NwYW4+PHNwYW4+JHtzYWZlVmFsdWV9PC9zcGFuPjwvc3Bhbj5gOwogIH0KICBmdW5jdGlvbiBnZXRIaXN0b3J5Q29sRWxlbWVudHMoKSB7CiAgICBjb25zdCBjb2xncm91cCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoaXN0b3J5LWNvbGdyb3VwJyk7CiAgICByZXR1cm4gY29sZ3JvdXAgPyBBcnJheS5mcm9tKGNvbGdyb3VwLnF1ZXJ5U2VsZWN0b3JBbGwoJ2NvbCcpKSA6IFtdOwogIH0KICBmdW5jdGlvbiBjbGFtcEhpc3RvcnlXaWR0aHMod2lkdGhzKSB7CiAgICByZXR1cm4gSElTVE9SWV9ERUZBVUxUX0NPTF9XSURUSFMubWFwKChmYWxsYmFjaywgaSkgPT4gewogICAgICBjb25zdCByYXcgPSBOdW1iZXIod2lkdGhzPy5baV0pOwogICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShyYXcpKSByZXR1cm4gZmFsbGJhY2s7CiAgICAgIGNvbnN0IG1pbiA9IEhJU1RPUllfTUlOX0NPTF9XSURUSFNbaV0gPz8gODA7CiAgICAgIHJldHVybiBNYXRoLm1heChtaW4sIE1hdGgucm91bmQocmF3KSk7CiAgICB9KTsKICB9CiAgZnVuY3Rpb24gc2F2ZUhpc3RvcnlDb2x1bW5XaWR0aHMod2lkdGhzKSB7CiAgICB0cnkgewogICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShISVNUT1JZX0NPTFNfS0VZLCBKU09OLnN0cmluZ2lmeShjbGFtcEhpc3RvcnlXaWR0aHMod2lkdGhzKSkpOwogICAgfSBjYXRjaCAoZSkgewogICAgICBjb25zb2xlLmVycm9yKCdbUmFkYXJNRVBdIG5vIHNlIHB1ZG8gZ3VhcmRhciBhbmNob3MgZGUgY29sdW1uYXMnLCBlKTsKICAgIH0KICB9CiAgZnVuY3Rpb24gbG9hZEhpc3RvcnlDb2x1bW5XaWR0aHMoKSB7CiAgICB0cnkgewogICAgICBjb25zdCByYXcgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShISVNUT1JZX0NPTFNfS0VZKTsKICAgICAgaWYgKCFyYXcpIHJldHVybiBudWxsOwogICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdyk7CiAgICAgIGlmICghQXJyYXkuaXNBcnJheShwYXJzZWQpIHx8IHBhcnNlZC5sZW5ndGggIT09IEhJU1RPUllfREVGQVVMVF9DT0xfV0lEVEhTLmxlbmd0aCkgcmV0dXJuIG51bGw7CiAgICAgIHJldHVybiBjbGFtcEhpc3RvcnlXaWR0aHMocGFyc2VkKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgY29uc29sZS5lcnJvcignW1JhZGFyTUVQXSBhbmNob3MgZGUgY29sdW1uYXMgaW52w6FsaWRvcycsIGUpOwogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICB9CiAgZnVuY3Rpb24gYXBwbHlIaXN0b3J5Q29sdW1uV2lkdGhzKHdpZHRocywgcGVyc2lzdCA9IGZhbHNlKSB7CiAgICBjb25zdCBjb2xzID0gZ2V0SGlzdG9yeUNvbEVsZW1lbnRzKCk7CiAgICBpZiAoY29scy5sZW5ndGggIT09IEhJU1RPUllfREVGQVVMVF9DT0xfV0lEVEhTLmxlbmd0aCkgcmV0dXJuOwogICAgY29uc3QgbmV4dCA9IGNsYW1wSGlzdG9yeVdpZHRocyh3aWR0aHMpOwogICAgY29scy5mb3JFYWNoKChjb2wsIGkpID0+IHsKICAgICAgY29sLnN0eWxlLndpZHRoID0gYCR7bmV4dFtpXX1weGA7CiAgICB9KTsKICAgIHN0YXRlLmhpc3RvcnlDb2xXaWR0aHMgPSBuZXh0OwogICAgaWYgKHBlcnNpc3QpIHNhdmVIaXN0b3J5Q29sdW1uV2lkdGhzKG5leHQpOwogIH0KICBmdW5jdGlvbiBpbml0SGlzdG9yeUNvbHVtbldpZHRocygpIHsKICAgIGNvbnN0IHNhdmVkID0gbG9hZEhpc3RvcnlDb2x1bW5XaWR0aHMoKTsKICAgIGFwcGx5SGlzdG9yeUNvbHVtbldpZHRocyhzYXZlZCB8fCBISVNUT1JZX0RFRkFVTFRfQ09MX1dJRFRIUywgZmFsc2UpOwogIH0KICBmdW5jdGlvbiBiaW5kSGlzdG9yeUNvbHVtblJlc2l6ZSgpIHsKICAgIGlmIChzdGF0ZS5oaXN0b3J5UmVzaXplQm91bmQpIHJldHVybjsKICAgIGNvbnN0IHRhYmxlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hpc3RvcnktdGFibGUnKTsKICAgIGlmICghdGFibGUpIHJldHVybjsKICAgIGNvbnN0IGhhbmRsZXMgPSBBcnJheS5mcm9tKHRhYmxlLnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb2wtcmVzaXplcicpKTsKICAgIGlmICghaGFuZGxlcy5sZW5ndGgpIHJldHVybjsKICAgIHN0YXRlLmhpc3RvcnlSZXNpemVCb3VuZCA9IHRydWU7CgogICAgaGFuZGxlcy5mb3JFYWNoKChoYW5kbGUpID0+IHsKICAgICAgaGFuZGxlLmFkZEV2ZW50TGlzdGVuZXIoJ2RibGNsaWNrJywgKGV2ZW50KSA9PiB7CiAgICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTsKICAgICAgICBjb25zdCBpZHggPSBOdW1iZXIoaGFuZGxlLmRhdGFzZXQuY29sSW5kZXgpOwogICAgICAgIGlmICghTnVtYmVyLmlzRmluaXRlKGlkeCkpIHJldHVybjsKICAgICAgICBjb25zdCBuZXh0ID0gc3RhdGUuaGlzdG9yeUNvbFdpZHRocy5zbGljZSgpOwogICAgICAgIG5leHRbaWR4XSA9IEhJU1RPUllfREVGQVVMVF9DT0xfV0lEVEhTW2lkeF07CiAgICAgICAgYXBwbHlIaXN0b3J5Q29sdW1uV2lkdGhzKG5leHQsIHRydWUpOwogICAgICB9KTsKICAgICAgaGFuZGxlLmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJkb3duJywgKGV2ZW50KSA9PiB7CiAgICAgICAgaWYgKGV2ZW50LmJ1dHRvbiAhPT0gMCkgcmV0dXJuOwogICAgICAgIGNvbnN0IGlkeCA9IE51bWJlcihoYW5kbGUuZGF0YXNldC5jb2xJbmRleCk7CiAgICAgICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoaWR4KSkgcmV0dXJuOwogICAgICAgIGNvbnN0IHN0YXJ0WCA9IGV2ZW50LmNsaWVudFg7CiAgICAgICAgY29uc3Qgc3RhcnRXaWR0aCA9IHN0YXRlLmhpc3RvcnlDb2xXaWR0aHNbaWR4XSA/PyBISVNUT1JZX0RFRkFVTFRfQ09MX1dJRFRIU1tpZHhdOwogICAgICAgIGhhbmRsZS5jbGFzc0xpc3QuYWRkKCdhY3RpdmUnKTsKICAgICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpOwoKICAgICAgICBjb25zdCBvbk1vdmUgPSAobW92ZUV2ZW50KSA9PiB7CiAgICAgICAgICBjb25zdCBkZWx0YSA9IG1vdmVFdmVudC5jbGllbnRYIC0gc3RhcnRYOwogICAgICAgICAgY29uc3QgbWluID0gSElTVE9SWV9NSU5fQ09MX1dJRFRIU1tpZHhdID8/IDgwOwogICAgICAgICAgY29uc3QgbmV4dFdpZHRoID0gTWF0aC5tYXgobWluLCBNYXRoLnJvdW5kKHN0YXJ0V2lkdGggKyBkZWx0YSkpOwogICAgICAgICAgY29uc3QgbmV4dCA9IHN0YXRlLmhpc3RvcnlDb2xXaWR0aHMuc2xpY2UoKTsKICAgICAgICAgIG5leHRbaWR4XSA9IG5leHRXaWR0aDsKICAgICAgICAgIGFwcGx5SGlzdG9yeUNvbHVtbldpZHRocyhuZXh0LCBmYWxzZSk7CiAgICAgICAgfTsKICAgICAgICBjb25zdCBvblVwID0gKCkgPT4gewogICAgICAgICAgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJtb3ZlJywgb25Nb3ZlKTsKICAgICAgICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKCdwb2ludGVydXAnLCBvblVwKTsKICAgICAgICAgIGhhbmRsZS5jbGFzc0xpc3QucmVtb3ZlKCdhY3RpdmUnKTsKICAgICAgICAgIHNhdmVIaXN0b3J5Q29sdW1uV2lkdGhzKHN0YXRlLmhpc3RvcnlDb2xXaWR0aHMpOwogICAgICAgIH07CiAgICAgICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJtb3ZlJywgb25Nb3ZlKTsKICAgICAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigncG9pbnRlcnVwJywgb25VcCk7CiAgICAgIH0pOwogICAgfSk7CiAgfQoKICAvLyAzKSBGdW5jaW9uZXMgZGUgcmVuZGVyCiAgZnVuY3Rpb24gcmVuZGVyTWVwQ2NsKHBheWxvYWQpIHsKICAgIGlmICghcGF5bG9hZCkgewogICAgICBzZXREYXNoKFsnbWVwLXZhbCcsICdjY2wtdmFsJywgJ2JyZWNoYS1hYnMnLCAnYnJlY2hhLXBjdCddKTsKICAgICAgc2V0VGV4dCgnc3RhdHVzLWxhYmVsJywgJ0RhdG9zIGluY29tcGxldG9zJyk7CiAgICAgIHNldFRleHQoJ3N0YXR1cy1iYWRnZScsICdTaW4gZGF0bycpOwogICAgICByZXR1cm47CiAgICB9CiAgICBjb25zdCBkYXRhID0gZXh0cmFjdFJvb3QocGF5bG9hZCk7CiAgICBjb25zdCBjdXJyZW50ID0gZGF0YSAmJiB0eXBlb2YgZGF0YS5jdXJyZW50ID09PSAnb2JqZWN0JyA/IGRhdGEuY3VycmVudCA6IG51bGw7CiAgICBjb25zdCBtZXAgPSBjdXJyZW50ID8gdG9OdW1iZXIoY3VycmVudC5tZXApIDogKHBpY2tOdW1iZXIoZGF0YSwgW1snbWVwJywgJ3ZlbnRhJ10sIFsnbWVwJywgJ3NlbGwnXSwgWydtZXAnXSwgWydtZXBfdmVudGEnXSwgWydkb2xhcl9tZXAnXV0pID8/IHBpY2tCeUtleUhpbnQoZGF0YSwgJ21lcCcpKTsKICAgIGNvbnN0IGNjbCA9IGN1cnJlbnQgPyB0b051bWJlcihjdXJyZW50LmNjbCkgOiAocGlja051bWJlcihkYXRhLCBbWydjY2wnLCAndmVudGEnXSwgWydjY2wnLCAnc2VsbCddLCBbJ2NjbCddLCBbJ2NjbF92ZW50YSddLCBbJ2RvbGFyX2NjbCddXSkgPz8gcGlja0J5S2V5SGludChkYXRhLCAnY2NsJykpOwogICAgY29uc3QgYWJzID0gY3VycmVudCA/IHRvTnVtYmVyKGN1cnJlbnQuYWJzRGlmZikgPz8gKG1lcCAhPT0gbnVsbCAmJiBjY2wgIT09IG51bGwgPyBNYXRoLmFicyhtZXAgLSBjY2wpIDogbnVsbCkgOiAobWVwICE9PSBudWxsICYmIGNjbCAhPT0gbnVsbCA/IE1hdGguYWJzKG1lcCAtIGNjbCkgOiBudWxsKTsKICAgIGNvbnN0IHBjdCA9IGN1cnJlbnQgPyB0b051bWJlcihjdXJyZW50LnBjdERpZmYpID8/IGJyZWNoYVBlcmNlbnQobWVwLCBjY2wpIDogYnJlY2hhUGVyY2VudChtZXAsIGNjbCk7CiAgICBjb25zdCBpc1NpbWlsYXIgPSBjdXJyZW50ICYmIHR5cGVvZiBjdXJyZW50LnNpbWlsYXIgPT09ICdib29sZWFuJwogICAgICA/IGN1cnJlbnQuc2ltaWxhcgogICAgICA6IChwY3QgIT09IG51bGwgJiYgYWJzICE9PSBudWxsICYmIChwY3QgPD0gU0lNSUxBUl9QQ1RfVEhSRVNIT0xEIHx8IGFicyA8PSBTSU1JTEFSX0FSU19USFJFU0hPTEQpKTsKCiAgICBzZXRUZXh0KCdtZXAtdmFsJywgZm9ybWF0TW9uZXkobWVwLCAyKSwgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ2NjbC12YWwnLCBmb3JtYXRNb25leShjY2wsIDIpLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc2V0VGV4dCgnYnJlY2hhLWFicycsIGFicyA9PT0gbnVsbCA/ICfigJQnIDogZm9ybWF0TW9uZXkoYWJzLCAyKSwgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ2JyZWNoYS1wY3QnLCBmb3JtYXRQZXJjZW50KHBjdCwgMiksIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdzdGF0dXMtbGFiZWwnLCBpc1NpbWlsYXIgPyAnTUVQIOKJiCBDQ0wnIDogJ01FUCDiiaAgQ0NMJyk7CiAgICBzZXRUZXh0KCdzdGF0dXMtYmFkZ2UnLCBpc1NpbWlsYXIgPyAnU2ltaWxhcicgOiAnTm8gc2ltaWxhcicpOwogICAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3RhdHVzLWJhZGdlJyk7CiAgICBpZiAoYmFkZ2UpIGJhZGdlLmNsYXNzTGlzdC50b2dnbGUoJ25vc2ltJywgIWlzU2ltaWxhcik7CgogICAgY29uc3QgYmFubmVyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3N0YXR1cy1iYW5uZXInKTsKICAgIGlmIChiYW5uZXIpIHsKICAgICAgYmFubmVyLmNsYXNzTGlzdC50b2dnbGUoJ3NpbWlsYXInLCAhIWlzU2ltaWxhcik7CiAgICAgIGJhbm5lci5jbGFzc0xpc3QudG9nZ2xlKCduby1zaW1pbGFyJywgIWlzU2ltaWxhcik7CiAgICB9CiAgICBjb25zdCBzdWIgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcjc3RhdHVzLWJhbm5lciAucy1zdWInKTsKICAgIGlmIChzdWIpIHsKICAgICAgc3ViLnRleHRDb250ZW50ID0gaXNTaW1pbGFyCiAgICAgICAgPyAnTGEgYnJlY2hhIGVzdMOhIGRlbnRybyBkZWwgdW1icmFsIOKAlCBsb3MgcHJlY2lvcyBzb24gY29tcGFyYWJsZXMnCiAgICAgICAgOiAnTGEgYnJlY2hhIHN1cGVyYSBlbCB1bWJyYWwg4oCUIGxvcyBwcmVjaW9zIG5vIHNvbiBjb21wYXJhYmxlcyc7CiAgICB9CiAgICBjb25zdCBpc09wZW4gPSBkYXRhPy5tYXJrZXQgJiYgdHlwZW9mIGRhdGEubWFya2V0LmlzT3BlbiA9PT0gJ2Jvb2xlYW4nID8gZGF0YS5tYXJrZXQuaXNPcGVuIDogbnVsbDsKICAgIGlmIChpc09wZW4gIT09IG51bGwpIHNldE1hcmtldFRhZyhpc09wZW4pOwogICAgc3RhdGUubGF0ZXN0Lm1lcCA9IG1lcDsKICAgIHN0YXRlLmxhdGVzdC5jY2wgPSBjY2w7CiAgICBzdGF0ZS5sYXRlc3QuYnJlY2hhQWJzID0gYWJzOwogICAgc3RhdGUubGF0ZXN0LmJyZWNoYVBjdCA9IHBjdDsKICB9CgogIGZ1bmN0aW9uIGlzU2ltaWxhclJvdyhyb3cpIHsKICAgIGNvbnN0IGFicyA9IHJvdy5hYnNfZGlmZiAhPSBudWxsID8gcm93LmFic19kaWZmIDogTWF0aC5hYnMocm93Lm1lcCAtIHJvdy5jY2wpOwogICAgY29uc3QgcGN0ID0gcm93LnBjdF9kaWZmICE9IG51bGwgPyByb3cucGN0X2RpZmYgOiBjYWxjQnJlY2hhUGN0KHJvdy5tZXAsIHJvdy5jY2wpOwogICAgcmV0dXJuIChOdW1iZXIuaXNGaW5pdGUocGN0KSAmJiBwY3QgPD0gU0lNSUxBUl9QQ1RfVEhSRVNIT0xEKSB8fCAoTnVtYmVyLmlzRmluaXRlKGFicykgJiYgYWJzIDw9IFNJTUlMQVJfQVJTX1RIUkVTSE9MRCk7CiAgfQoKICBmdW5jdGlvbiBmaWx0ZXJEZXNjcmlwdG9yKG1vZGUgPSBzdGF0ZS5maWx0ZXJNb2RlKSB7CiAgICBpZiAobW9kZSA9PT0gJzFtJykgcmV0dXJuICcxIE1lcyc7CiAgICBpZiAobW9kZSA9PT0gJzF3JykgcmV0dXJuICcxIFNlbWFuYSc7CiAgICByZXR1cm4gJzEgRMOtYSc7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJNZXRyaWNzMjRoKHBheWxvYWQpIHsKICAgIGNvbnN0IGZpbHRlcmVkID0gZmlsdGVySGlzdG9yeVJvd3MoZXh0cmFjdEhpc3RvcnlSb3dzKHBheWxvYWQpLCBzdGF0ZS5maWx0ZXJNb2RlKTsKICAgIGNvbnN0IHBjdFZhbHVlcyA9IGZpbHRlcmVkLm1hcCgocikgPT4gKHIucGN0X2RpZmYgIT0gbnVsbCA/IHIucGN0X2RpZmYgOiBjYWxjQnJlY2hhUGN0KHIubWVwLCByLmNjbCkpKS5maWx0ZXIoKHYpID0+IE51bWJlci5pc0Zpbml0ZSh2KSk7CiAgICBjb25zdCBzaW1pbGFyQ291bnQgPSBmaWx0ZXJlZC5maWx0ZXIoKHIpID0+IGlzU2ltaWxhclJvdyhyKSkubGVuZ3RoOwogICAgY29uc3QgZGVzY3JpcHRvciA9IGZpbHRlckRlc2NyaXB0b3IoKTsKCiAgICBzZXRUZXh0KCdtZXRyaWMtY291bnQtbGFiZWwnLCBgTXVlc3RyYXMgJHtkZXNjcmlwdG9yfWApOwogICAgc2V0VGV4dCgnbWV0cmljLWNvdW50LTI0aCcsIFN0cmluZyhmaWx0ZXJlZC5sZW5ndGgpLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc2V0VGV4dCgnbWV0cmljLWNvdW50LXN1YicsICdyZWdpc3Ryb3MgZGVsIHBlcsOtb2RvIGZpbHRyYWRvJyk7CiAgICBzZXRUZXh0KCdtZXRyaWMtc2ltaWxhci1sYWJlbCcsIGBWZWNlcyBzaW1pbGFyICgke2Rlc2NyaXB0b3J9KWApOwogICAgc2V0VGV4dCgnbWV0cmljLXNpbWlsYXItMjRoJywgU3RyaW5nKHNpbWlsYXJDb3VudCksIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdtZXRyaWMtc2ltaWxhci1zdWInLCAnbW9tZW50b3MgZW4gem9uYSDiiaQxJSBvIOKJpCQxMCcpOwogICAgc2V0VGV4dCgnbWV0cmljLW1pbi1sYWJlbCcsIGBCcmVjaGEgbcOtbi4gKCR7ZGVzY3JpcHRvcn0pYCk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWluLTI0aCcsIHBjdFZhbHVlcy5sZW5ndGggPyBmb3JtYXRQZXJjZW50KE1hdGgubWluKC4uLnBjdFZhbHVlcyksIDIpIDogJ+KAlCcsIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWluLXN1YicsICdtw61uaW1hIGRlbCBwZXLDrW9kbyBmaWx0cmFkbycpOwogICAgc2V0VGV4dCgnbWV0cmljLW1heC1sYWJlbCcsIGBCcmVjaGEgbcOheC4gKCR7ZGVzY3JpcHRvcn0pYCk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWF4LTI0aCcsIHBjdFZhbHVlcy5sZW5ndGggPyBmb3JtYXRQZXJjZW50KE1hdGgubWF4KC4uLnBjdFZhbHVlcyksIDIpIDogJ+KAlCcsIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWF4LXN1YicsICdtw6F4aW1hIGRlbCBwZXLDrW9kbyBmaWx0cmFkbycpOwogICAgc2V0VGV4dCgndHJlbmQtdGl0bGUnLCBgVGVuZGVuY2lhIE1FUC9DQ0wg4oCUICR7ZGVzY3JpcHRvcn1gKTsKICB9CgogIGZ1bmN0aW9uIHJvd0hvdXJMYWJlbChlcG9jaCkgewogICAgY29uc3QgbiA9IHRvTnVtYmVyKGVwb2NoKTsKICAgIGlmIChuID09PSBudWxsKSByZXR1cm4gJ+KAlCc7CiAgICByZXR1cm4gZm10QXJnSG91ci5mb3JtYXQobmV3IERhdGUobiAqIDEwMDApKTsKICB9CiAgZnVuY3Rpb24gcm93RGF5SG91ckxhYmVsKGVwb2NoKSB7CiAgICBjb25zdCBuID0gdG9OdW1iZXIoZXBvY2gpOwogICAgaWYgKG4gPT09IG51bGwpIHJldHVybiAn4oCUJzsKICAgIGNvbnN0IGRhdGUgPSBuZXcgRGF0ZShuICogMTAwMCk7CiAgICByZXR1cm4gYCR7Zm10QXJnRGF5TW9udGguZm9ybWF0KGRhdGUpfSAke2ZtdEFyZ0hvdXIuZm9ybWF0KGRhdGUpfWA7CiAgfQogIGZ1bmN0aW9uIGFydERhdGVLZXkoZXBvY2gpIHsKICAgIGNvbnN0IG4gPSB0b051bWJlcihlcG9jaCk7CiAgICBpZiAobiA9PT0gbnVsbCkgcmV0dXJuIG51bGw7CiAgICByZXR1cm4gZm10QXJnRGF0ZS5mb3JtYXQobmV3IERhdGUobiAqIDEwMDApKTsKICB9CiAgZnVuY3Rpb24gYXJ0V2Vla2RheShlcG9jaCkgewogICAgY29uc3QgbiA9IHRvTnVtYmVyKGVwb2NoKTsKICAgIGlmIChuID09PSBudWxsKSByZXR1cm4gbnVsbDsKICAgIHJldHVybiBmbXRBcmdXZWVrZGF5LmZvcm1hdChuZXcgRGF0ZShuICogMTAwMCkpOwogIH0KICBmdW5jdGlvbiBleHRyYWN0SGlzdG9yeVJvd3MocGF5bG9hZCkgewogICAgY29uc3QgZGF0YSA9IGV4dHJhY3RSb290KHBheWxvYWQpOwogICAgY29uc3Qgcm93cyA9IEFycmF5LmlzQXJyYXkoZGF0YS5oaXN0b3J5KSA/IGRhdGEuaGlzdG9yeS5zbGljZSgpIDogW107CiAgICByZXR1cm4gcm93cwogICAgICAubWFwKChyKSA9PiAoewogICAgICAgIGVwb2NoOiB0b051bWJlcihyLmVwb2NoKSwKICAgICAgICBtZXA6IHRvTnVtYmVyKHIubWVwKSwKICAgICAgICBjY2w6IHRvTnVtYmVyKHIuY2NsKSwKICAgICAgICBhYnNfZGlmZjogdG9OdW1iZXIoci5hYnNfZGlmZiksCiAgICAgICAgcGN0X2RpZmY6IHRvTnVtYmVyKHIucGN0X2RpZmYpLAogICAgICAgIHNpbWlsYXI6IEJvb2xlYW4oci5zaW1pbGFyKQogICAgICB9KSkKICAgICAgLmZpbHRlcigocikgPT4gci5lcG9jaCAhPSBudWxsICYmIHIubWVwICE9IG51bGwgJiYgci5jY2wgIT0gbnVsbCkKICAgICAgLnNvcnQoKGEsIGIpID0+IGEuZXBvY2ggLSBiLmVwb2NoKTsKICB9CiAgZnVuY3Rpb24gZmlsdGVySGlzdG9yeVJvd3Mocm93cywgbW9kZSkgewogICAgaWYgKCFyb3dzLmxlbmd0aCkgcmV0dXJuIFtdOwogICAgY29uc3QgbGF0ZXN0RXBvY2ggPSByb3dzW3Jvd3MubGVuZ3RoIC0gMV0uZXBvY2g7CiAgICBpZiAobW9kZSA9PT0gJzFtJykgewogICAgICBjb25zdCBjdXRvZmYgPSBsYXRlc3RFcG9jaCAtICgzMCAqIDI0ICogMzYwMCk7CiAgICAgIHJldHVybiByb3dzLmZpbHRlcigocikgPT4gci5lcG9jaCA+PSBjdXRvZmYpOwogICAgfQogICAgaWYgKG1vZGUgPT09ICcxdycpIHsKICAgICAgY29uc3QgYWxsb3dlZERheXMgPSBuZXcgU2V0KCk7CiAgICAgIGZvciAobGV0IGkgPSByb3dzLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7CiAgICAgICAgY29uc3QgZGF5ID0gYXJ0RGF0ZUtleShyb3dzW2ldLmVwb2NoKTsKICAgICAgICBjb25zdCB3ZCA9IGFydFdlZWtkYXkocm93c1tpXS5lcG9jaCk7CiAgICAgICAgaWYgKCFkYXkgfHwgd2QgPT09ICdTYXQnIHx8IHdkID09PSAnU3VuJykgY29udGludWU7CiAgICAgICAgYWxsb3dlZERheXMuYWRkKGRheSk7CiAgICAgICAgaWYgKGFsbG93ZWREYXlzLnNpemUgPj0gNSkgYnJlYWs7CiAgICAgIH0KICAgICAgcmV0dXJuIHJvd3MuZmlsdGVyKChyKSA9PiB7CiAgICAgICAgY29uc3QgZGF5ID0gYXJ0RGF0ZUtleShyLmVwb2NoKTsKICAgICAgICByZXR1cm4gZGF5ICYmIGFsbG93ZWREYXlzLmhhcyhkYXkpOwogICAgICB9KTsKICAgIH0KICAgIGNvbnN0IGN1dG9mZiA9IGxhdGVzdEVwb2NoIC0gKDI0ICogMzYwMCk7CiAgICByZXR1cm4gcm93cy5maWx0ZXIoKHIpID0+IHIuZXBvY2ggPj0gY3V0b2ZmKTsKICB9CiAgZnVuY3Rpb24gZG93bnNhbXBsZVJvd3Mocm93cywgbWF4UG9pbnRzKSB7CiAgICBpZiAocm93cy5sZW5ndGggPD0gbWF4UG9pbnRzKSByZXR1cm4gcm93czsKICAgIGNvbnN0IG91dCA9IFtdOwogICAgY29uc3Qgc3RlcCA9IChyb3dzLmxlbmd0aCAtIDEpIC8gKG1heFBvaW50cyAtIDEpOwogICAgZm9yIChsZXQgaSA9IDA7IGkgPCBtYXhQb2ludHM7IGkrKykgewogICAgICBvdXQucHVzaChyb3dzW01hdGgucm91bmQoaSAqIHN0ZXApXSk7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KICBmdW5jdGlvbiBjdXJyZW50RmlsdGVyTGFiZWwoKSB7CiAgICBpZiAoc3RhdGUuZmlsdGVyTW9kZSA9PT0gJzFtJykgcmV0dXJuICcxIE1lcyc7CiAgICBpZiAoc3RhdGUuZmlsdGVyTW9kZSA9PT0gJzF3JykgcmV0dXJuICcxIFNlbWFuYSc7CiAgICByZXR1cm4gJzEgRMOtYSc7CiAgfQogIGZ1bmN0aW9uIGdldEZpbHRlcmVkSGlzdG9yeVJvd3MocGF5bG9hZCA9IHN0YXRlLmxhc3RNZXBQYXlsb2FkKSB7CiAgICBpZiAoIXBheWxvYWQpIHJldHVybiBbXTsKICAgIHJldHVybiBmaWx0ZXJIaXN0b3J5Um93cyhleHRyYWN0SGlzdG9yeVJvd3MocGF5bG9hZCksIHN0YXRlLmZpbHRlck1vZGUpOwogIH0KICBmdW5jdGlvbiBjc3ZFc2NhcGUodmFsdWUpIHsKICAgIGNvbnN0IHYgPSBTdHJpbmcodmFsdWUgPz8gJycpOwogICAgcmV0dXJuIGAiJHt2LnJlcGxhY2UoLyIvZywgJyIiJyl9ImA7CiAgfQogIGZ1bmN0aW9uIGNzdk51bWJlcih2YWx1ZSwgZGlnaXRzID0gMikgewogICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUodmFsdWUpKSByZXR1cm4gJ+KAlCc7CiAgICByZXR1cm4gdmFsdWUudG9GaXhlZChkaWdpdHMpLnJlcGxhY2UoJy4nLCAnLCcpOwogIH0KICBmdW5jdGlvbiBmaWx0ZXJDb2RlKCkgewogICAgaWYgKHN0YXRlLmZpbHRlck1vZGUgPT09ICcxbScpIHJldHVybiAnMW0nOwogICAgaWYgKHN0YXRlLmZpbHRlck1vZGUgPT09ICcxdycpIHJldHVybiAnMXcnOwogICAgcmV0dXJuICcxZCc7CiAgfQogIGZ1bmN0aW9uIGRvd25sb2FkSGlzdG9yeUNzdigpIHsKICAgIGNvbnN0IGZpbHRlcmVkID0gZ2V0RmlsdGVyZWRIaXN0b3J5Um93cygpOwogICAgaWYgKCFmaWx0ZXJlZC5sZW5ndGgpIHsKICAgICAgc2V0RnJlc2hCYWRnZSgnU2luIGRhdG9zIHBhcmEgZXhwb3J0YXIgZW4gZWwgZmlsdHJvIGFjdGl2bycsICdpZGxlJyk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IGhlYWRlciA9IFsnZmVjaGEnLCAnaG9yYScsICdtZXAnLCAnY2NsJywgJ2RpZl9hYnMnLCAnZGlmX3BjdCcsICdlc3RhZG8nXTsKICAgIGNvbnN0IHJvd3MgPSBmaWx0ZXJlZC5tYXAoKHIpID0+IHsKICAgICAgY29uc3QgZGF0ZSA9IG5ldyBEYXRlKHIuZXBvY2ggKiAxMDAwKTsKICAgICAgY29uc3QgbWVwID0gdG9OdW1iZXIoci5tZXApOwogICAgICBjb25zdCBjY2wgPSB0b051bWJlcihyLmNjbCk7CiAgICAgIGNvbnN0IGFicyA9IHRvTnVtYmVyKHIuYWJzX2RpZmYpOwogICAgICBjb25zdCBwY3QgPSB0b051bWJlcihyLnBjdF9kaWZmKTsKICAgICAgY29uc3QgZXN0YWRvID0gQm9vbGVhbihyLnNpbWlsYXIpID8gJ1NJTUlMQVInIDogJ05PIFNJTUlMQVInOwogICAgICByZXR1cm4gWwogICAgICAgIGZtdEFyZ0RheU1vbnRoLmZvcm1hdChkYXRlKSwKICAgICAgICBmbXRBcmdIb3VyLmZvcm1hdChkYXRlKSwKICAgICAgICBjc3ZOdW1iZXIobWVwLCAyKSwKICAgICAgICBjc3ZOdW1iZXIoY2NsLCAyKSwKICAgICAgICBjc3ZOdW1iZXIoYWJzLCAyKSwKICAgICAgICBjc3ZOdW1iZXIocGN0LCAyKSwKICAgICAgICBlc3RhZG8KICAgICAgXS5tYXAoY3N2RXNjYXBlKS5qb2luKCc7Jyk7CiAgICB9KTsKICAgIGNvbnN0IGFydERhdGUgPSBmbXRBcmdEYXRlLmZvcm1hdChuZXcgRGF0ZSgpKTsKICAgIGNvbnN0IGZpbGVuYW1lID0gYGhpc3RvcmlhbC1tZXAtY2NsLSR7ZmlsdGVyQ29kZSgpfS0ke2FydERhdGV9LmNzdmA7CiAgICBjb25zdCBjc3YgPSAnXHVGRUZGJyArIFtoZWFkZXIuam9pbignOycpLCAuLi5yb3dzXS5qb2luKCdcbicpOwogICAgY29uc3QgYmxvYiA9IG5ldyBCbG9iKFtjc3ZdLCB7IHR5cGU6ICd0ZXh0L2NzdjtjaGFyc2V0PXV0Zi04OycgfSk7CiAgICBjb25zdCB1cmwgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKGJsb2IpOwogICAgY29uc3QgYSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2EnKTsKICAgIGEuaHJlZiA9IHVybDsKICAgIGEuZG93bmxvYWQgPSBmaWxlbmFtZTsKICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoYSk7CiAgICBhLmNsaWNrKCk7CiAgICBhLnJlbW92ZSgpOwogICAgVVJMLnJldm9rZU9iamVjdFVSTCh1cmwpOwogIH0KICBmdW5jdGlvbiBhcHBseUZpbHRlcihtb2RlKSB7CiAgICBzdGF0ZS5maWx0ZXJNb2RlID0gbW9kZTsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5waWxsW2RhdGEtZmlsdGVyXScpLmZvckVhY2goKGJ0bikgPT4gewogICAgICBidG4uY2xhc3NMaXN0LnRvZ2dsZSgnb24nLCBidG4uZGF0YXNldC5maWx0ZXIgPT09IG1vZGUpOwogICAgfSk7CiAgICBpZiAoc3RhdGUubGFzdE1lcFBheWxvYWQpIHsKICAgICAgcmVuZGVyVHJlbmQoc3RhdGUubGFzdE1lcFBheWxvYWQpOwogICAgICByZW5kZXJIaXN0b3J5KHN0YXRlLmxhc3RNZXBQYXlsb2FkKTsKICAgICAgcmVuZGVyTWV0cmljczI0aChzdGF0ZS5sYXN0TWVwUGF5bG9hZCk7CiAgICB9CiAgfQoKICBmdW5jdGlvbiByZW5kZXJIaXN0b3J5KHBheWxvYWQpIHsKICAgIGNvbnN0IHRib2R5ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hpc3Rvcnktcm93cycpOwogICAgY29uc3QgY2FwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hpc3RvcnktY2FwJyk7CiAgICBpZiAoIXRib2R5KSByZXR1cm47CiAgICBjb25zdCBmaWx0ZXJlZCA9IGdldEZpbHRlcmVkSGlzdG9yeVJvd3MocGF5bG9hZCk7CiAgICBjb25zdCByb3dzID0gZmlsdGVyZWQuc2xpY2UoKS5yZXZlcnNlKCk7CiAgICBpZiAoY2FwKSBjYXAudGV4dENvbnRlbnQgPSBgJHtjdXJyZW50RmlsdGVyTGFiZWwoKX0gwrcgJHtyb3dzLmxlbmd0aH0gcmVnaXN0cm9zYDsKICAgIGlmICghcm93cy5sZW5ndGgpIHsKICAgICAgdGJvZHkuaW5uZXJIVE1MID0gJzx0cj48dGQgY2xhc3M9ImRpbSIgY29sc3Bhbj0iNiI+U2luIHJlZ2lzdHJvcyB0b2RhdsOtYTwvdGQ+PC90cj4nOwogICAgICByZXR1cm47CiAgICB9CiAgICB0Ym9keS5pbm5lckhUTUwgPSByb3dzLm1hcCgocikgPT4gewogICAgICBjb25zdCBtZXAgPSB0b051bWJlcihyLm1lcCk7CiAgICAgIGNvbnN0IGNjbCA9IHRvTnVtYmVyKHIuY2NsKTsKICAgICAgY29uc3QgYWJzID0gdG9OdW1iZXIoci5hYnNfZGlmZik7CiAgICAgIGNvbnN0IHBjdCA9IHRvTnVtYmVyKHIucGN0X2RpZmYpOwogICAgICBjb25zdCBzaW0gPSBCb29sZWFuKHIuc2ltaWxhcik7CiAgICAgIHJldHVybiBgPHRyPgogICAgICAgIDx0ZCBjbGFzcz0iZGltIj48ZGl2IGNsYXNzPSJ0cy1kYXkiPiR7Zm10QXJnRGF5TW9udGguZm9ybWF0KG5ldyBEYXRlKHIuZXBvY2ggKiAxMDAwKSl9PC9kaXY+PGRpdiBjbGFzcz0idHMtaG91ciI+JHtyb3dIb3VyTGFiZWwoci5lcG9jaCl9PC9kaXY+PC90ZD4KICAgICAgICA8dGQgc3R5bGU9ImNvbG9yOnZhcigtLW1lcCkiPiR7Zm9ybWF0TW9uZXkobWVwLCAyKX08L3RkPgogICAgICAgIDx0ZCBzdHlsZT0iY29sb3I6dmFyKC0tY2NsKSI+JHtmb3JtYXRNb25leShjY2wsIDIpfTwvdGQ+CiAgICAgICAgPHRkPiR7Zm9ybWF0TW9uZXkoYWJzLCAyKX08L3RkPgogICAgICAgIDx0ZD4ke2Zvcm1hdFBlcmNlbnQocGN0LCAyKX08L3RkPgogICAgICAgIDx0ZD48c3BhbiBjbGFzcz0ic2JhZGdlICR7c2ltID8gJ3NpbScgOiAnbm9zaW0nfSI+JHtzaW0gPyAnU2ltaWxhcicgOiAnTm8gc2ltaWxhcid9PC9zcGFuPjwvdGQ+CiAgICAgIDwvdHI+YDsKICAgIH0pLmpvaW4oJycpOwogIH0KCiAgZnVuY3Rpb24gbGluZVBvaW50cyh2YWx1ZXMsIHgwLCB4MSwgeTAsIHkxLCBtaW5WYWx1ZSwgbWF4VmFsdWUpIHsKICAgIGlmICghdmFsdWVzLmxlbmd0aCkgcmV0dXJuICcnOwogICAgY29uc3QgbWluID0gTnVtYmVyLmlzRmluaXRlKG1pblZhbHVlKSA/IG1pblZhbHVlIDogTWF0aC5taW4oLi4udmFsdWVzKTsKICAgIGNvbnN0IG1heCA9IE51bWJlci5pc0Zpbml0ZShtYXhWYWx1ZSkgPyBtYXhWYWx1ZSA6IE1hdGgubWF4KC4uLnZhbHVlcyk7CiAgICBjb25zdCBzcGFuID0gTWF0aC5tYXgoMC4wMDAwMDEsIG1heCAtIG1pbik7CiAgICByZXR1cm4gdmFsdWVzLm1hcCgodiwgaSkgPT4gewogICAgICBjb25zdCB4ID0geDAgKyAoKHgxIC0geDApICogaSAvIE1hdGgubWF4KDEsIHZhbHVlcy5sZW5ndGggLSAxKSk7CiAgICAgIGNvbnN0IHkgPSB5MSAtICgodiAtIG1pbikgLyBzcGFuKSAqICh5MSAtIHkwKTsKICAgICAgcmV0dXJuIGAke3gudG9GaXhlZCgyKX0sJHt5LnRvRml4ZWQoMil9YDsKICAgIH0pLmpvaW4oJyAnKTsKICB9CiAgZnVuY3Rpb24gdmFsdWVUb1kodmFsdWUsIHkwLCB5MSwgbWluVmFsdWUsIG1heFZhbHVlKSB7CiAgICBjb25zdCBzcGFuID0gTWF0aC5tYXgoMC4wMDAwMDEsIG1heFZhbHVlIC0gbWluVmFsdWUpOwogICAgcmV0dXJuIHkxIC0gKCh2YWx1ZSAtIG1pblZhbHVlKSAvIHNwYW4pICogKHkxIC0geTApOwogIH0KICBmdW5jdGlvbiBjYWxjQnJlY2hhUGN0KG1lcCwgY2NsKSB7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShtZXApIHx8ICFOdW1iZXIuaXNGaW5pdGUoY2NsKSkgcmV0dXJuIG51bGw7CiAgICBjb25zdCBhdmcgPSAobWVwICsgY2NsKSAvIDI7CiAgICBpZiAoIWF2ZykgcmV0dXJuIG51bGw7CiAgICByZXR1cm4gKE1hdGguYWJzKG1lcCAtIGNjbCkgLyBhdmcpICogMTAwOwogIH0KICBmdW5jdGlvbiBoaWRlVHJlbmRIb3ZlcigpIHsKICAgIGNvbnN0IHRpcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC10b29sdGlwJyk7CiAgICBjb25zdCBsaW5lID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLWhvdmVyLWxpbmUnKTsKICAgIGNvbnN0IG1lcERvdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1ob3Zlci1tZXAnKTsKICAgIGNvbnN0IGNjbERvdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1ob3Zlci1jY2wnKTsKICAgIGlmICh0aXApIHRpcC5zZXRBdHRyaWJ1dGUoJ29wYWNpdHknLCAnMCcpOwogICAgaWYgKGxpbmUpIGxpbmUuc2V0QXR0cmlidXRlKCdvcGFjaXR5JywgJzAnKTsKICAgIGlmIChtZXBEb3QpIG1lcERvdC5zZXRBdHRyaWJ1dGUoJ29wYWNpdHknLCAnMCcpOwogICAgaWYgKGNjbERvdCkgY2NsRG90LnNldEF0dHJpYnV0ZSgnb3BhY2l0eScsICcwJyk7CiAgfQogIGZ1bmN0aW9uIHJlbmRlclRyZW5kSG92ZXIocG9pbnQpIHsKICAgIGNvbnN0IHRpcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC10b29sdGlwJyk7CiAgICBjb25zdCBiZyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC10b29sdGlwLWJnJyk7CiAgICBjb25zdCBsaW5lID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLWhvdmVyLWxpbmUnKTsKICAgIGNvbnN0IG1lcERvdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1ob3Zlci1tZXAnKTsKICAgIGNvbnN0IGNjbERvdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1ob3Zlci1jY2wnKTsKICAgIGlmICghdGlwIHx8ICFiZyB8fCAhbGluZSB8fCAhbWVwRG90IHx8ICFjY2xEb3QgfHwgIXBvaW50KSByZXR1cm47CgogICAgbGluZS5zZXRBdHRyaWJ1dGUoJ3gxJywgcG9pbnQueC50b0ZpeGVkKDIpKTsKICAgIGxpbmUuc2V0QXR0cmlidXRlKCd4MicsIHBvaW50LngudG9GaXhlZCgyKSk7CiAgICBsaW5lLnNldEF0dHJpYnV0ZSgnb3BhY2l0eScsICcxJyk7CiAgICBtZXBEb3Quc2V0QXR0cmlidXRlKCdjeCcsIHBvaW50LngudG9GaXhlZCgyKSk7CiAgICBtZXBEb3Quc2V0QXR0cmlidXRlKCdjeScsIHBvaW50Lm1lcFkudG9GaXhlZCgyKSk7CiAgICBtZXBEb3Quc2V0QXR0cmlidXRlKCdvcGFjaXR5JywgJzEnKTsKICAgIGNjbERvdC5zZXRBdHRyaWJ1dGUoJ2N4JywgcG9pbnQueC50b0ZpeGVkKDIpKTsKICAgIGNjbERvdC5zZXRBdHRyaWJ1dGUoJ2N5JywgcG9pbnQuY2NsWS50b0ZpeGVkKDIpKTsKICAgIGNjbERvdC5zZXRBdHRyaWJ1dGUoJ29wYWNpdHknLCAnMScpOwoKICAgIHNldFRleHQoJ3RyZW5kLXRpcC10aW1lJywgcm93RGF5SG91ckxhYmVsKHBvaW50LmVwb2NoKSk7CiAgICBzZXRUZXh0KCd0cmVuZC10aXAtbWVwJywgYE1FUCAke2Zvcm1hdE1vbmV5KHBvaW50Lm1lcCwgMil9YCk7CiAgICBzZXRUZXh0KCd0cmVuZC10aXAtY2NsJywgYENDTCAke2Zvcm1hdE1vbmV5KHBvaW50LmNjbCwgMil9YCk7CiAgICBzZXRUZXh0KCd0cmVuZC10aXAtZ2FwJywgYEJyZWNoYSAke2Zvcm1hdFBlcmNlbnQocG9pbnQucGN0LCAyKX1gKTsKCiAgICBjb25zdCB0aXBXID0gMTQ4OwogICAgY29uc3QgdGlwSCA9IDU2OwogICAgY29uc3QgdGlwWCA9IE1hdGgubWluKDg0MCAtIHRpcFcsIE1hdGgubWF4KDMwLCBwb2ludC54ICsgMTApKTsKICAgIGNvbnN0IHRpcFkgPSBNYXRoLm1pbigxMDAsIE1hdGgubWF4KDE4LCBNYXRoLm1pbihwb2ludC5tZXBZLCBwb2ludC5jY2xZKSAtIHRpcEggLSA0KSk7CiAgICB0aXAuc2V0QXR0cmlidXRlKCd0cmFuc2Zvcm0nLCBgdHJhbnNsYXRlKCR7dGlwWC50b0ZpeGVkKDIpfSAke3RpcFkudG9GaXhlZCgyKX0pYCk7CiAgICBiZy5zZXRBdHRyaWJ1dGUoJ3dpZHRoJywgU3RyaW5nKHRpcFcpKTsKICAgIGJnLnNldEF0dHJpYnV0ZSgnaGVpZ2h0JywgU3RyaW5nKHRpcEgpKTsKICAgIHRpcC5zZXRBdHRyaWJ1dGUoJ29wYWNpdHknLCAnMScpOwogIH0KICBmdW5jdGlvbiBiaW5kVHJlbmRIb3ZlcigpIHsKICAgIGlmIChzdGF0ZS50cmVuZEhvdmVyQm91bmQpIHJldHVybjsKICAgIGNvbnN0IGNoYXJ0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RyZW5kLWNoYXJ0Jyk7CiAgICBpZiAoIWNoYXJ0KSByZXR1cm47CiAgICBzdGF0ZS50cmVuZEhvdmVyQm91bmQgPSB0cnVlOwoKICAgIGNoYXJ0LmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlbGVhdmUnLCAoKSA9PiBoaWRlVHJlbmRIb3ZlcigpKTsKICAgIGNoYXJ0LmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlbW92ZScsIChldmVudCkgPT4gewogICAgICBpZiAoIXN0YXRlLnRyZW5kUm93cy5sZW5ndGgpIHJldHVybjsKICAgICAgY29uc3QgY3RtID0gY2hhcnQuZ2V0U2NyZWVuQ1RNKCk7CiAgICAgIGlmICghY3RtKSByZXR1cm47CiAgICAgIGNvbnN0IHB0ID0gY2hhcnQuY3JlYXRlU1ZHUG9pbnQoKTsKICAgICAgcHQueCA9IGV2ZW50LmNsaWVudFg7CiAgICAgIHB0LnkgPSBldmVudC5jbGllbnRZOwogICAgICBjb25zdCBsb2NhbCA9IHB0Lm1hdHJpeFRyYW5zZm9ybShjdG0uaW52ZXJzZSgpKTsKICAgICAgY29uc3QgeCA9IE1hdGgubWF4KDMwLCBNYXRoLm1pbig4NDAsIGxvY2FsLngpKTsKICAgICAgbGV0IG5lYXJlc3QgPSBzdGF0ZS50cmVuZFJvd3NbMF07CiAgICAgIGxldCBiZXN0ID0gTWF0aC5hYnMobmVhcmVzdC54IC0geCk7CiAgICAgIGZvciAobGV0IGkgPSAxOyBpIDwgc3RhdGUudHJlbmRSb3dzLmxlbmd0aDsgaSsrKSB7CiAgICAgICAgY29uc3QgZCA9IE1hdGguYWJzKHN0YXRlLnRyZW5kUm93c1tpXS54IC0geCk7CiAgICAgICAgaWYgKGQgPCBiZXN0KSB7CiAgICAgICAgICBiZXN0ID0gZDsKICAgICAgICAgIG5lYXJlc3QgPSBzdGF0ZS50cmVuZFJvd3NbaV07CiAgICAgICAgfQogICAgICB9CiAgICAgIHJlbmRlclRyZW5kSG92ZXIobmVhcmVzdCk7CiAgICB9KTsKICB9CgogIGZ1bmN0aW9uIHJlbmRlclRyZW5kKHBheWxvYWQpIHsKICAgIGNvbnN0IGhpc3RvcnkgPSBkb3duc2FtcGxlUm93cyhmaWx0ZXJIaXN0b3J5Um93cyhleHRyYWN0SGlzdG9yeVJvd3MocGF5bG9hZCksIHN0YXRlLmZpbHRlck1vZGUpLCBUUkVORF9NQVhfUE9JTlRTKTsKICAgIGNvbnN0IG1lcExpbmUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtbWVwLWxpbmUnKTsKICAgIGNvbnN0IGNjbExpbmUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHJlbmQtY2NsLWxpbmUnKTsKICAgIGlmICghbWVwTGluZSB8fCAhY2NsTGluZSkgcmV0dXJuOwogICAgYmluZFRyZW5kSG92ZXIoKTsKICAgIGlmICghaGlzdG9yeS5sZW5ndGgpIHsKICAgICAgbWVwTGluZS5zZXRBdHRyaWJ1dGUoJ3BvaW50cycsICcnKTsKICAgICAgY2NsTGluZS5zZXRBdHRyaWJ1dGUoJ3BvaW50cycsICcnKTsKICAgICAgc3RhdGUudHJlbmRSb3dzID0gW107CiAgICAgIGhpZGVUcmVuZEhvdmVyKCk7CiAgICAgIFsndHJlbmQteS10b3AnLCAndHJlbmQteS1taWQnLCAndHJlbmQteS1sb3cnLCAndHJlbmQteC0xJywgJ3RyZW5kLXgtMicsICd0cmVuZC14LTMnLCAndHJlbmQteC00JywgJ3RyZW5kLXgtNSddLmZvckVhY2goKGlkKSA9PiBzZXRUZXh0KGlkLCAn4oCUJykpOwogICAgICByZXR1cm47CiAgICB9CgogICAgY29uc3Qgcm93cyA9IGhpc3RvcnkKICAgICAgLm1hcCgocikgPT4gKHsKICAgICAgICBlcG9jaDogci5lcG9jaCwKICAgICAgICBtZXA6IHRvTnVtYmVyKHIubWVwKSwKICAgICAgICBjY2w6IHRvTnVtYmVyKHIuY2NsKSwKICAgICAgICBwY3Q6IHRvTnVtYmVyKHIucGN0X2RpZmYpCiAgICAgIH0pKQogICAgICAuZmlsdGVyKChyKSA9PiByLm1lcCAhPSBudWxsICYmIHIuY2NsICE9IG51bGwpOwogICAgaWYgKCFyb3dzLmxlbmd0aCkgcmV0dXJuOwoKICAgIGNvbnN0IG1lcFZhbHMgPSByb3dzLm1hcCgocikgPT4gci5tZXApOwogICAgY29uc3QgY2NsVmFscyA9IHJvd3MubWFwKChyKSA9PiByLmNjbCk7CgogICAgLy8gRXNjYWxhIGNvbXBhcnRpZGEgcGFyYSBNRVAgeSBDQ0w6IGNvbXBhcmFjacOzbiB2aXN1YWwgZmllbC4KICAgIGNvbnN0IGFsbFByaWNlVmFscyA9IG1lcFZhbHMuY29uY2F0KGNjbFZhbHMpOwogICAgY29uc3QgcmF3TWluID0gTWF0aC5taW4oLi4uYWxsUHJpY2VWYWxzKTsKICAgIGNvbnN0IHJhd01heCA9IE1hdGgubWF4KC4uLmFsbFByaWNlVmFscyk7CiAgICBjb25zdCBwcmljZVBhZCA9IE1hdGgubWF4KDEsIChyYXdNYXggLSByYXdNaW4pICogMC4wOCk7CiAgICBjb25zdCBwcmljZU1pbiA9IHJhd01pbiAtIHByaWNlUGFkOwogICAgY29uc3QgcHJpY2VNYXggPSByYXdNYXggKyBwcmljZVBhZDsKCiAgICBtZXBMaW5lLnNldEF0dHJpYnV0ZSgncG9pbnRzJywgbGluZVBvaW50cyhtZXBWYWxzLCAzMCwgODQwLCAyNSwgMTMwLCBwcmljZU1pbiwgcHJpY2VNYXgpKTsKICAgIGNjbExpbmUuc2V0QXR0cmlidXRlKCdwb2ludHMnLCBsaW5lUG9pbnRzKGNjbFZhbHMsIDMwLCA4NDAsIDI1LCAxMzAsIHByaWNlTWluLCBwcmljZU1heCkpOwogICAgc3RhdGUudHJlbmRSb3dzID0gcm93cy5tYXAoKHIsIGkpID0+IHsKICAgICAgY29uc3QgeCA9IDMwICsgKCg4NDAgLSAzMCkgKiBpIC8gTWF0aC5tYXgoMSwgcm93cy5sZW5ndGggLSAxKSk7CiAgICAgIHJldHVybiB7CiAgICAgICAgZXBvY2g6IHIuZXBvY2gsCiAgICAgICAgbWVwOiByLm1lcCwKICAgICAgICBjY2w6IHIuY2NsLAogICAgICAgIHBjdDogY2FsY0JyZWNoYVBjdChyLm1lcCwgci5jY2wpLAogICAgICAgIHgsCiAgICAgICAgbWVwWTogdmFsdWVUb1koci5tZXAsIDI1LCAxMzAsIHByaWNlTWluLCBwcmljZU1heCksCiAgICAgICAgY2NsWTogdmFsdWVUb1koci5jY2wsIDI1LCAxMzAsIHByaWNlTWluLCBwcmljZU1heCkKICAgICAgfTsKICAgIH0pOwogICAgaGlkZVRyZW5kSG92ZXIoKTsKCiAgICBjb25zdCBtaWQgPSAocHJpY2VNaW4gKyBwcmljZU1heCkgLyAyOwogICAgc2V0VGV4dCgndHJlbmQteS10b3AnLCAocHJpY2VNYXggLyAxMDAwKS50b0ZpeGVkKDMpKTsKICAgIHNldFRleHQoJ3RyZW5kLXktbWlkJywgKG1pZCAvIDEwMDApLnRvRml4ZWQoMykpOwogICAgc2V0VGV4dCgndHJlbmQteS1sb3cnLCAocHJpY2VNaW4gLyAxMDAwKS50b0ZpeGVkKDMpKTsKCiAgICBjb25zdCBpZHggPSBbMCwgMC4yNSwgMC41LCAwLjc1LCAxXS5tYXAoKHApID0+IE1hdGgubWluKHJvd3MubGVuZ3RoIC0gMSwgTWF0aC5mbG9vcigocm93cy5sZW5ndGggLSAxKSAqIHApKSk7CiAgICBjb25zdCBsYWJzID0gaWR4Lm1hcCgoaSkgPT4gcm93RGF5SG91ckxhYmVsKHJvd3NbaV0/LmVwb2NoKSk7CiAgICBzZXRUZXh0KCd0cmVuZC14LTEnLCBsYWJzWzBdIHx8ICfigJQnKTsKICAgIHNldFRleHQoJ3RyZW5kLXgtMicsIGxhYnNbMV0gfHwgJ+KAlCcpOwogICAgc2V0VGV4dCgndHJlbmQteC0zJywgbGFic1syXSB8fCAn4oCUJyk7CiAgICBzZXRUZXh0KCd0cmVuZC14LTQnLCBsYWJzWzNdIHx8ICfigJQnKTsKICAgIHNldFRleHQoJ3RyZW5kLXgtNScsIGxhYnNbNF0gfHwgJ+KAlCcpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyRmNpUmVudGFGaWphKHBheWxvYWQsIHByZXZpb3VzUGF5bG9hZCkgewogICAgY29uc3Qgcm93c0VsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZjaS1yb3dzJyk7CiAgICBjb25zdCBlbXB0eUVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZjaS1lbXB0eScpOwogICAgaWYgKCFyb3dzRWwgfHwgIWVtcHR5RWwpIHJldHVybjsKICAgIGlmIChhcmd1bWVudHMubGVuZ3RoID4gMSkgewogICAgICBjb25zdCBwcmV2aW91c1Jvd3MgPSBub3JtYWxpemVGY2lSb3dzKHByZXZpb3VzUGF5bG9hZCkKICAgICAgICAubWFwKChpdGVtKSA9PiB7CiAgICAgICAgICBjb25zdCBmb25kbyA9IFN0cmluZyhpdGVtPy5mb25kbyB8fCBpdGVtPy5ub21icmUgfHwgaXRlbT8uZmNpIHx8ICcnKS50cmltKCk7CiAgICAgICAgICBjb25zdCB2Y3AgPSB0b051bWJlcihpdGVtPy52Y3ApOwogICAgICAgICAgY29uc3QgY2NwID0gdG9OdW1iZXIoaXRlbT8uY2NwKTsKICAgICAgICAgIGNvbnN0IHBhdHJpbW9uaW8gPSB0b051bWJlcihpdGVtPy5wYXRyaW1vbmlvKTsKICAgICAgICAgIHJldHVybiB7IGZvbmRvLCB2Y3AsIGNjcCwgcGF0cmltb25pbyB9OwogICAgICAgIH0pCiAgICAgICAgLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5mb25kbyk7CiAgICAgIGNvbnN0IHByZXZpb3VzTWFwID0gbmV3IE1hcCgpOwogICAgICBwcmV2aW91c1Jvd3MuZm9yRWFjaCgoaXRlbSkgPT4gewogICAgICAgIHByZXZpb3VzTWFwLnNldChub3JtYWxpemVGY2lGb25kb0tleShpdGVtLmZvbmRvKSwgaXRlbSk7CiAgICAgIH0pOwogICAgICBzdGF0ZS5mY2lQcmV2aW91c0J5Rm9uZG8gPSBwcmV2aW91c01hcDsKICAgIH0KICAgIGlmIChhcmd1bWVudHMubGVuZ3RoID4gMCkgewogICAgICBjb25zdCByb3dzID0gbm9ybWFsaXplRmNpUm93cyhwYXlsb2FkKQogICAgICAgIC5tYXAoKGl0ZW0pID0+IHsKICAgICAgICAgIGNvbnN0IGZvbmRvID0gU3RyaW5nKGl0ZW0/LmZvbmRvIHx8IGl0ZW0/Lm5vbWJyZSB8fCBpdGVtPy5mY2kgfHwgJycpLnRyaW0oKTsKICAgICAgICAgIGNvbnN0IGZlY2hhID0gU3RyaW5nKGl0ZW0/LmZlY2hhIHx8ICcnKS50cmltKCk7CiAgICAgICAgICBjb25zdCB2Y3AgPSB0b051bWJlcihpdGVtPy52Y3ApOwogICAgICAgICAgY29uc3QgY2NwID0gdG9OdW1iZXIoaXRlbT8uY2NwKTsKICAgICAgICAgIGNvbnN0IHBhdHJpbW9uaW8gPSB0b051bWJlcihpdGVtPy5wYXRyaW1vbmlvKTsKICAgICAgICAgIGNvbnN0IGhvcml6b250ZSA9IFN0cmluZyhpdGVtPy5ob3Jpem9udGUgfHwgJycpLnRyaW0oKTsKICAgICAgICAgIGNvbnN0IHByZXZpb3VzID0gc3RhdGUuZmNpUHJldmlvdXNCeUZvbmRvLmdldChub3JtYWxpemVGY2lGb25kb0tleShmb25kbykpOwogICAgICAgICAgcmV0dXJuIHsKICAgICAgICAgICAgZm9uZG8sCiAgICAgICAgICAgIGZlY2hhLAogICAgICAgICAgICB2Y3AsCiAgICAgICAgICAgIGNjcCwKICAgICAgICAgICAgcGF0cmltb25pbywKICAgICAgICAgICAgaG9yaXpvbnRlLAogICAgICAgICAgICB2Y3BEaXJlY3Rpb246IGZjaURpcmVjdGlvbih2Y3AsIHByZXZpb3VzPy52Y3ApLAogICAgICAgICAgICBjY3BEaXJlY3Rpb246IGZjaURpcmVjdGlvbihjY3AsIHByZXZpb3VzPy5jY3ApLAogICAgICAgICAgICBwYXRyaW1vbmlvRGlyZWN0aW9uOiBmY2lEaXJlY3Rpb24ocGF0cmltb25pbywgcHJldmlvdXM/LnBhdHJpbW9uaW8pCiAgICAgICAgICB9OwogICAgICAgIH0pCiAgICAgICAgLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5mb25kbyAmJiAoaXRlbS52Y3AgIT09IG51bGwgfHwgaXRlbS5mZWNoYSkpOwogICAgICBzdGF0ZS5mY2lSb3dzID0gcm93cy5zbGljZSgpLnNvcnQoKGEsIGIpID0+IChiLnBhdHJpbW9uaW8gPz8gLUluZmluaXR5KSAtIChhLnBhdHJpbW9uaW8gPz8gLUluZmluaXR5KSk7CiAgICAgIHN0YXRlLmZjaVBhZ2UgPSAxOwogICAgfQoKICAgIGNvbnN0IHF1ZXJ5ID0gc3RhdGUuZmNpUXVlcnkudHJpbSgpLnRvTG93ZXJDYXNlKCk7CiAgICBjb25zdCBmaWx0ZXJlZCA9IHF1ZXJ5CiAgICAgID8gc3RhdGUuZmNpUm93cy5maWx0ZXIoKHJvdykgPT4gcm93LmZvbmRvLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMocXVlcnkpKQogICAgICA6IHN0YXRlLmZjaVJvd3Muc2xpY2UoKTsKCiAgICBjb25zdCB0b3RhbFBhZ2VzID0gTWF0aC5tYXgoMSwgTWF0aC5jZWlsKGZpbHRlcmVkLmxlbmd0aCAvIEZDSV9QQUdFX1NJWkUpKTsKICAgIHN0YXRlLmZjaVBhZ2UgPSBNYXRoLm1pbihNYXRoLm1heCgxLCBzdGF0ZS5mY2lQYWdlKSwgdG90YWxQYWdlcyk7CiAgICBjb25zdCBmcm9tID0gKHN0YXRlLmZjaVBhZ2UgLSAxKSAqIEZDSV9QQUdFX1NJWkU7CiAgICBjb25zdCBwYWdlUm93cyA9IGZpbHRlcmVkLnNsaWNlKGZyb20sIGZyb20gKyBGQ0lfUEFHRV9TSVpFKTsKCiAgICBjb25zdCBkYXRlRWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLWxhc3QtZGF0ZScpOwogICAgY29uc3QgZmlyc3REYXRlID0gZmlsdGVyZWQuZmluZCgocm93KSA9PiByb3cuZmVjaGEpPy5mZWNoYSB8fCAn4oCUJzsKICAgIGlmIChkYXRlRWwpIGRhdGVFbC50ZXh0Q29udGVudCA9IGBGZWNoYTogJHtmaXJzdERhdGV9YDsKICAgIHNldFRleHQoJ2ZjaS1wYWdlLWluZm8nLCBgJHtzdGF0ZS5mY2lQYWdlfSAvICR7dG90YWxQYWdlc31gKTsKICAgIGNvbnN0IHByZXZCdG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLXByZXYnKTsKICAgIGNvbnN0IG5leHRCdG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLW5leHQnKTsKICAgIGlmIChwcmV2QnRuKSBwcmV2QnRuLmRpc2FibGVkID0gc3RhdGUuZmNpUGFnZSA8PSAxOwogICAgaWYgKG5leHRCdG4pIG5leHRCdG4uZGlzYWJsZWQgPSBzdGF0ZS5mY2lQYWdlID49IHRvdGFsUGFnZXM7CgogICAgaWYgKCFwYWdlUm93cy5sZW5ndGgpIHsKICAgICAgcm93c0VsLmlubmVySFRNTCA9ICcnOwogICAgICBpZiAocXVlcnkpIGVtcHR5RWwudGV4dENvbnRlbnQgPSAnTm8gaGF5IHJlc3VsdGFkb3MgcGFyYSBsYSBiw7pzcXVlZGEgaW5kaWNhZGEuJzsKICAgICAgZWxzZSBlbXB0eUVsLnRleHRDb250ZW50ID0gJ05vIGhheSBkYXRvcyBkZSByZW50YSBmaWphIGRpc3BvbmlibGVzIGVuIGVzdGUgbW9tZW50by4nOwogICAgICBlbXB0eUVsLnN0eWxlLmRpc3BsYXkgPSAnYmxvY2snOwogICAgICByZXR1cm47CiAgICB9CgogICAgZW1wdHlFbC5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOwogICAgcm93c0VsLmlubmVySFRNTCA9IHBhZ2VSb3dzLm1hcCgocm93KSA9PiBgCiAgICAgIDx0cj4KICAgICAgICA8dGQ+JHtlc2NhcGVIdG1sKHJvdy5mb25kbyl9PC90ZD4KICAgICAgICA8dGQ+JHtyZW5kZXJGY2lWYWx1ZVdpdGhUcmVuZChyb3cudmNwLCByb3cudmNwRGlyZWN0aW9uKX08L3RkPgogICAgICAgIDx0ZD4ke3JlbmRlckZjaVZhbHVlV2l0aFRyZW5kKHJvdy5jY3AsIHJvdy5jY3BEaXJlY3Rpb24pfTwvdGQ+CiAgICAgICAgPHRkPiR7cmVuZGVyRmNpVmFsdWVXaXRoVHJlbmQocm93LnBhdHJpbW9uaW8sIHJvdy5wYXRyaW1vbmlvRGlyZWN0aW9uKX08L3RkPgogICAgICAgIDx0ZD4ke2VzY2FwZUh0bWwocm93Lmhvcml6b250ZSB8fCAn4oCUJyl9PC90ZD4KICAgICAgPC90cj4KICAgIGApLmpvaW4oJycpOwogIH0KCiAgLy8gNCkgRnVuY2nDs24gY2VudHJhbCBmZXRjaEFsbCgpCiAgYXN5bmMgZnVuY3Rpb24gZmV0Y2hKc29uKHVybCkgewogICAgY29uc3QgY3RybCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTsKICAgIGNvbnN0IHRpbWVvdXQgPSBzZXRUaW1lb3V0KCgpID0+IGN0cmwuYWJvcnQoKSwgMTIwMDApOwogICAgdHJ5IHsKICAgICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2godXJsLCB7IGNhY2hlOiAnbm8tc3RvcmUnLCBzaWduYWw6IGN0cmwuc2lnbmFsIH0pOwogICAgICBpZiAoIXJlcy5vaykgdGhyb3cgbmV3IEVycm9yKGBIVFRQICR7cmVzLnN0YXR1c31gKTsKICAgICAgcmV0dXJuIGF3YWl0IHJlcy5qc29uKCk7CiAgICB9IGZpbmFsbHkgewogICAgICBjbGVhclRpbWVvdXQodGltZW91dCk7CiAgICB9CiAgfQoKICBhc3luYyBmdW5jdGlvbiBmZXRjaEFsbChvcHRpb25zID0ge30pIHsKICAgIGlmIChzdGF0ZS5pc0ZldGNoaW5nKSByZXR1cm47CiAgICBzdGF0ZS5pc0ZldGNoaW5nID0gdHJ1ZTsKICAgIHNldExvYWRpbmcoTlVNRVJJQ19JRFMsIHRydWUpOwogICAgc2V0RnJlc2hCYWRnZSgnQWN0dWFsaXphbmRv4oCmJywgJ2ZldGNoaW5nJyk7CiAgICBzZXRFcnJvckJhbm5lcihmYWxzZSk7CiAgICB0cnkgewogICAgICBjb25zdCB0YXNrcyA9IFsKICAgICAgICBbJ21lcENjbCcsIEVORFBPSU5UUy5tZXBDY2xdLAogICAgICAgIFsnZmNpUmVudGFGaWphJywgRU5EUE9JTlRTLmZjaVJlbnRhRmlqYV0sCiAgICAgICAgWydmY2lSZW50YUZpamFQZW51bHRpbW8nLCBFTkRQT0lOVFMuZmNpUmVudGFGaWphUGVudWx0aW1vXQogICAgICBdOwoKICAgICAgY29uc3Qgc2V0dGxlZCA9IGF3YWl0IFByb21pc2UuYWxsU2V0dGxlZCh0YXNrcy5tYXAoYXN5bmMgKFtuYW1lLCB1cmxdKSA9PiB7CiAgICAgICAgdHJ5IHsKICAgICAgICAgIGNvbnN0IGRhdGEgPSBhd2FpdCBmZXRjaEpzb24odXJsKTsKICAgICAgICAgIHJldHVybiB7IG5hbWUsIGRhdGEgfTsKICAgICAgICB9IGNhdGNoIChlcnJvcikgewogICAgICAgICAgY29uc29sZS5lcnJvcihgW1JhZGFyTUVQXSBlcnJvciBlbiAke25hbWV9YCwgZXJyb3IpOwogICAgICAgICAgdGhyb3cgeyBuYW1lLCBlcnJvciB9OwogICAgICAgIH0KICAgICAgfSkpOwoKICAgICAgY29uc3QgYmFnID0geyB0aW1lc3RhbXA6IERhdGUubm93KCksIG1lcENjbDogbnVsbCwgZmNpUmVudGFGaWphOiBudWxsLCBmY2lSZW50YUZpamFQZW51bHRpbW86IG51bGwgfTsKICAgICAgY29uc3QgZmFpbGVkID0gW107CiAgICAgIHNldHRsZWQuZm9yRWFjaCgociwgaWR4KSA9PiB7CiAgICAgICAgY29uc3QgbmFtZSA9IHRhc2tzW2lkeF1bMF07CiAgICAgICAgaWYgKHIuc3RhdHVzID09PSAnZnVsZmlsbGVkJykgYmFnW25hbWVdID0gci52YWx1ZS5kYXRhOwogICAgICAgIGVsc2UgZmFpbGVkLnB1c2gobmFtZSk7CiAgICAgIH0pOwoKICAgICAgcmVuZGVyTWVwQ2NsKGJhZy5tZXBDY2wpOwogICAgICByZW5kZXJGY2lSZW50YUZpamEoYmFnLmZjaVJlbnRhRmlqYSwgYmFnLmZjaVJlbnRhRmlqYVBlbnVsdGltbyk7CiAgICAgIHN0YXRlLmxhc3RNZXBQYXlsb2FkID0gYmFnLm1lcENjbDsKICAgICAgcmVuZGVyTWV0cmljczI0aChiYWcubWVwQ2NsKTsKICAgICAgcmVuZGVyVHJlbmQoYmFnLm1lcENjbCk7CiAgICAgIHJlbmRlckhpc3RvcnkoYmFnLm1lcENjbCk7CiAgICAgIGNvbnN0IG1lcFJvb3QgPSBleHRyYWN0Um9vdChiYWcubWVwQ2NsKTsKICAgICAgY29uc3QgdXBkYXRlZEFydCA9IHR5cGVvZiBtZXBSb290Py51cGRhdGVkQXRIdW1hbkFydCA9PT0gJ3N0cmluZycgPyBtZXBSb290LnVwZGF0ZWRBdEh1bWFuQXJ0IDogbnVsbDsKICAgICAgY29uc3Qgc291cmNlVHNNcyA9IHRvTnVtYmVyKG1lcFJvb3Q/LnNvdXJjZVN0YXR1cz8ubGF0ZXN0U291cmNlVHNNcykKICAgICAgICA/PyB0b051bWJlcihtZXBSb290Py5jdXJyZW50Py5tZXBUc01zKQogICAgICAgID8/IHRvTnVtYmVyKG1lcFJvb3Q/LmN1cnJlbnQ/LmNjbFRzTXMpCiAgICAgICAgPz8gbnVsbDsKICAgICAgc3RhdGUuc291cmNlVHNNcyA9IHNvdXJjZVRzTXM7CiAgICAgIHNldFRleHQoJ2xhc3QtcnVuLXRpbWUnLCB1cGRhdGVkQXJ0IHx8IGZtdEFyZ1RpbWVTZWMuZm9ybWF0KG5ldyBEYXRlKCkpKTsKCiAgICAgIGNvbnN0IHN1Y2Nlc3NDb3VudCA9IHRhc2tzLmxlbmd0aCAtIGZhaWxlZC5sZW5ndGg7CiAgICAgIGlmIChzdWNjZXNzQ291bnQgPiAwKSB7CiAgICAgICAgc3RhdGUubGFzdFN1Y2Nlc3NBdCA9IERhdGUubm93KCk7CiAgICAgICAgc3RhdGUucmV0cnlJbmRleCA9IDA7CiAgICAgICAgaWYgKHN0YXRlLnJldHJ5VGltZXIpIGNsZWFyVGltZW91dChzdGF0ZS5yZXRyeVRpbWVyKTsKICAgICAgICBzYXZlQ2FjaGUoYmFnKTsKICAgICAgICBjb25zdCBhZ2VMYWJlbCA9IHNvdXJjZVRzTXMgIT0gbnVsbCA/IGZvcm1hdFNvdXJjZUFnZUxhYmVsKHNvdXJjZVRzTXMpIDogbnVsbDsKICAgICAgICBjb25zdCBiYWRnZUJhc2UgPSBhZ2VMYWJlbCA/IGDDmmx0aW1hIGFjdHVhbGl6YWNpw7NuIGhhY2U6ICR7YWdlTGFiZWx9YCA6IGBBY3R1YWxpemFkbyDCtyAke2ZtdEFyZ1RpbWUuZm9ybWF0KG5ldyBEYXRlKCkpfWA7CiAgICAgICAgaWYgKGZhaWxlZC5sZW5ndGgpIHNldEZyZXNoQmFkZ2UoYEFjdHVhbGl6YWNpw7NuIHBhcmNpYWwgwrcgJHtiYWRnZUJhc2V9YCwgJ2lkbGUnKTsKICAgICAgICBlbHNlIHNldEZyZXNoQmFkZ2UoYmFkZ2VCYXNlLCAnaWRsZScpOwogICAgICAgIHJlZnJlc2hGcmVzaEJhZGdlRnJvbVNvdXJjZSgpOwogICAgICB9IGVsc2UgewogICAgICAgIGNvbnN0IGF0dGVtcHQgPSBzdGF0ZS5yZXRyeUluZGV4ICsgMTsKICAgICAgICBpZiAoc3RhdGUucmV0cnlJbmRleCA8IFJFVFJZX0RFTEFZUy5sZW5ndGgpIHsKICAgICAgICAgIGNvbnN0IGRlbGF5ID0gUkVUUllfREVMQVlTW3N0YXRlLnJldHJ5SW5kZXhdOwogICAgICAgICAgc3RhdGUucmV0cnlJbmRleCArPSAxOwogICAgICAgICAgc2V0RnJlc2hCYWRnZShgRXJyb3IgwrcgUmVpbnRlbnRvIGVuICR7TWF0aC5yb3VuZChkZWxheSAvIDEwMDApfXNgLCAnZXJyb3InKTsKICAgICAgICAgIGlmIChzdGF0ZS5yZXRyeVRpbWVyKSBjbGVhclRpbWVvdXQoc3RhdGUucmV0cnlUaW1lcik7CiAgICAgICAgICBzdGF0ZS5yZXRyeVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBmZXRjaEFsbCh7IG1hbnVhbDogdHJ1ZSB9KSwgZGVsYXkpOwogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICBzZXRGcmVzaEJhZGdlKCdFcnJvciDCtyBSZWludGVudGFyJywgJ2Vycm9yJyk7CiAgICAgICAgICBzZXRFcnJvckJhbm5lcih0cnVlLCAnRXJyb3IgYWwgYWN0dWFsaXphciDCtyBSZWludGVudGFyJyk7CiAgICAgICAgICBjb25zb2xlLmVycm9yKGBbUmFkYXJNRVBdIHNlIGFnb3Rhcm9uIHJldHJpZXMgKCR7YXR0ZW1wdH0gaW50ZW50b3MpYCk7CiAgICAgICAgICBpZiAod2luZG93LnNjaGVkdWxlcikgd2luZG93LnNjaGVkdWxlci5zdG9wKCk7CiAgICAgICAgfQogICAgICB9CiAgICB9IGZpbmFsbHkgewogICAgICBzZXRMb2FkaW5nKE5VTUVSSUNfSURTLCBmYWxzZSk7CiAgICAgIHN0YXRlLmlzRmV0Y2hpbmcgPSBmYWxzZTsKICAgIH0KICB9CgogIC8vIDUpIENsYXNlIE1hcmtldFNjaGVkdWxlcgogIGNsYXNzIE1hcmtldFNjaGVkdWxlciB7CiAgICBjb25zdHJ1Y3RvcihmZXRjaEZuLCBpbnRlcnZhbE1zID0gMzAwMDAwKSB7CiAgICAgIHRoaXMuZmV0Y2hGbiA9IGZldGNoRm47CiAgICAgIHRoaXMuaW50ZXJ2YWxNcyA9IGludGVydmFsTXM7CiAgICAgIHRoaXMudGltZXIgPSBudWxsOwogICAgICB0aGlzLndhaXRUaW1lciA9IG51bGw7CiAgICAgIHRoaXMuY291bnRkb3duVGltZXIgPSBudWxsOwogICAgICB0aGlzLm5leHRSdW5BdCA9IG51bGw7CiAgICAgIHRoaXMucnVubmluZyA9IGZhbHNlOwogICAgICB0aGlzLnBhdXNlZCA9IGZhbHNlOwogICAgfQoKICAgIHN0YXJ0KCkgewogICAgICBpZiAodGhpcy5ydW5uaW5nKSByZXR1cm47CiAgICAgIHRoaXMucnVubmluZyA9IHRydWU7CiAgICAgIHRoaXMucGF1c2VkID0gZmFsc2U7CiAgICAgIGlmICh0aGlzLmlzTWFya2V0T3BlbigpKSB7CiAgICAgICAgc2V0TWFya2V0VGFnKHRydWUpOwogICAgICAgIHRoaXMuX3NjaGVkdWxlKHRoaXMuaW50ZXJ2YWxNcyk7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgc2V0TWFya2V0VGFnKGZhbHNlKTsKICAgICAgICB0aGlzLl93YWl0Rm9yT3BlbigpOwogICAgICB9CiAgICAgIHRoaXMuX3N0YXJ0Q291bnRkb3duKCk7CiAgICB9CgogICAgcGF1c2UoKSB7CiAgICAgIHRoaXMucGF1c2VkID0gdHJ1ZTsKICAgICAgY2xlYXJUaW1lb3V0KHRoaXMudGltZXIpOwogICAgICBjbGVhclRpbWVvdXQodGhpcy53YWl0VGltZXIpOwogICAgICB0aGlzLnRpbWVyID0gbnVsbDsKICAgICAgdGhpcy53YWl0VGltZXIgPSBudWxsOwogICAgICB0aGlzLl9zdG9wQ291bnRkb3duKCk7CiAgICAgIGNvbnN0IGNvdW50ZG93biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb3VudGRvd24tdGV4dCcpOwogICAgICBpZiAoY291bnRkb3duKSBjb3VudGRvd24udGV4dENvbnRlbnQgPSAnQWN0dWFsaXphY2nDs24gcGF1c2FkYSc7CiAgICB9CgogICAgcmVzdW1lKCkgewogICAgICBpZiAoIXRoaXMucnVubmluZykgdGhpcy5ydW5uaW5nID0gdHJ1ZTsKICAgICAgdGhpcy5wYXVzZWQgPSBmYWxzZTsKICAgICAgY29uc3QgY29udGludWVSZXN1bWUgPSAoKSA9PiB7CiAgICAgICAgaWYgKHRoaXMuaXNNYXJrZXRPcGVuKCkpIHsKICAgICAgICAgIHNldE1hcmtldFRhZyh0cnVlKTsKICAgICAgICAgIHRoaXMuX3NjaGVkdWxlKHRoaXMuaW50ZXJ2YWxNcyk7CiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgIHNldE1hcmtldFRhZyhmYWxzZSk7CiAgICAgICAgICB0aGlzLl93YWl0Rm9yT3BlbigpOwogICAgICAgIH0KICAgICAgICB0aGlzLl9zdGFydENvdW50ZG93bigpOwogICAgICB9OwogICAgICBpZiAoRGF0ZS5ub3coKSAtIHN0YXRlLmxhc3RTdWNjZXNzQXQgPiB0aGlzLmludGVydmFsTXMpIHsKICAgICAgICBQcm9taXNlLnJlc29sdmUodGhpcy5mZXRjaEZuKHsgbWFudWFsOiB0cnVlIH0pKS5maW5hbGx5KGNvbnRpbnVlUmVzdW1lKTsKICAgICAgfSBlbHNlIHsKICAgICAgICBjb250aW51ZVJlc3VtZSgpOwogICAgICB9CiAgICB9CgogICAgc3RvcCgpIHsKICAgICAgdGhpcy5ydW5uaW5nID0gZmFsc2U7CiAgICAgIHRoaXMucGF1c2VkID0gZmFsc2U7CiAgICAgIGNsZWFyVGltZW91dCh0aGlzLnRpbWVyKTsKICAgICAgY2xlYXJUaW1lb3V0KHRoaXMud2FpdFRpbWVyKTsKICAgICAgdGhpcy50aW1lciA9IG51bGw7CiAgICAgIHRoaXMud2FpdFRpbWVyID0gbnVsbDsKICAgICAgdGhpcy5uZXh0UnVuQXQgPSBudWxsOwogICAgICB0aGlzLl9zdG9wQ291bnRkb3duKCk7CiAgICB9CgogICAgaXNNYXJrZXRPcGVuKCkgewogICAgICBjb25zdCBwID0gZ2V0QXJnTm93UGFydHMoKTsKICAgICAgY29uc3QgYnVzaW5lc3NEYXkgPSBwLndlZWtkYXkgPj0gMSAmJiBwLndlZWtkYXkgPD0gNTsKICAgICAgY29uc3Qgc2Vjb25kcyA9IHAuaG91ciAqIDM2MDAgKyBwLm1pbnV0ZSAqIDYwICsgcC5zZWNvbmQ7CiAgICAgIGNvbnN0IGZyb20gPSAxMCAqIDM2MDAgKyAzMCAqIDYwOwogICAgICBjb25zdCB0byA9IDE4ICogMzYwMDsKICAgICAgcmV0dXJuIGJ1c2luZXNzRGF5ICYmIHNlY29uZHMgPj0gZnJvbSAmJiBzZWNvbmRzIDwgdG87CiAgICB9CgogICAgZ2V0TmV4dFJ1blRpbWUoKSB7CiAgICAgIHJldHVybiB0aGlzLm5leHRSdW5BdCA/IG5ldyBEYXRlKHRoaXMubmV4dFJ1bkF0KSA6IG51bGw7CiAgICB9CgogICAgX3NjaGVkdWxlKGRlbGF5TXMpIHsKICAgICAgaWYgKCF0aGlzLnJ1bm5pbmcgfHwgdGhpcy5wYXVzZWQpIHJldHVybjsKICAgICAgY2xlYXJUaW1lb3V0KHRoaXMudGltZXIpOwogICAgICB0aGlzLm5leHRSdW5BdCA9IERhdGUubm93KCkgKyBkZWxheU1zOwogICAgICB0aGlzLnRpbWVyID0gc2V0VGltZW91dChhc3luYyAoKSA9PiB7CiAgICAgICAgaWYgKCF0aGlzLnJ1bm5pbmcgfHwgdGhpcy5wYXVzZWQpIHJldHVybjsKICAgICAgICBpZiAoIXRoaXMuaXNNYXJrZXRPcGVuKCkpIHsKICAgICAgICAgIHNldE1hcmtldFRhZyhmYWxzZSk7CiAgICAgICAgICB0aGlzLl93YWl0Rm9yT3BlbigpOwogICAgICAgICAgcmV0dXJuOwogICAgICAgIH0KICAgICAgICBzZXRNYXJrZXRUYWcodHJ1ZSk7CiAgICAgICAgYXdhaXQgdGhpcy5mZXRjaEZuKCk7CiAgICAgICAgdGhpcy5fc2NoZWR1bGUodGhpcy5pbnRlcnZhbE1zKTsKICAgICAgfSwgZGVsYXlNcyk7CiAgICB9CgogICAgX3dhaXRGb3JPcGVuKCkgewogICAgICBpZiAoIXRoaXMucnVubmluZyB8fCB0aGlzLnBhdXNlZCkgcmV0dXJuOwogICAgICBjbGVhclRpbWVvdXQodGhpcy53YWl0VGltZXIpOwogICAgICB0aGlzLm5leHRSdW5BdCA9IERhdGUubm93KCkgKyA2MDAwMDsKICAgICAgdGhpcy53YWl0VGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHsKICAgICAgICBpZiAoIXRoaXMucnVubmluZyB8fCB0aGlzLnBhdXNlZCkgcmV0dXJuOwogICAgICAgIGlmICh0aGlzLmlzTWFya2V0T3BlbigpKSB7CiAgICAgICAgICBzZXRNYXJrZXRUYWcodHJ1ZSk7CiAgICAgICAgICB0aGlzLmZldGNoRm4oeyBtYW51YWw6IHRydWUgfSk7CiAgICAgICAgICB0aGlzLl9zY2hlZHVsZSh0aGlzLmludGVydmFsTXMpOwogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICBzZXRNYXJrZXRUYWcoZmFsc2UpOwogICAgICAgICAgdGhpcy5fd2FpdEZvck9wZW4oKTsKICAgICAgICB9CiAgICAgIH0sIDYwMDAwKTsKICAgIH0KCiAgICBfc3RhcnRDb3VudGRvd24oKSB7CiAgICAgIHRoaXMuX3N0b3BDb3VudGRvd24oKTsKICAgICAgdGhpcy5jb3VudGRvd25UaW1lciA9IHNldEludGVydmFsKCgpID0+IHsKICAgICAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb3VudGRvd24tdGV4dCcpOwogICAgICAgIGlmICghZWwgfHwgdGhpcy5wYXVzZWQpIHJldHVybjsKICAgICAgICBjb25zdCBuZXh0ID0gdGhpcy5nZXROZXh0UnVuVGltZSgpOwogICAgICAgIGlmICghbmV4dCkgewogICAgICAgICAgZWwudGV4dENvbnRlbnQgPSB0aGlzLmlzTWFya2V0T3BlbigpID8gJ1Byw7N4aW1hIGFjdHVhbGl6YWNpw7NuIGVuIOKAlCcgOiAnTWVyY2FkbyBjZXJyYWRvJzsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgICAgY29uc3QgZGlmZiA9IE1hdGgubWF4KDAsIG5leHQuZ2V0VGltZSgpIC0gRGF0ZS5ub3coKSk7CiAgICAgICAgY29uc3QgbSA9IE1hdGguZmxvb3IoZGlmZiAvIDYwMDAwKTsKICAgICAgICBjb25zdCBzID0gTWF0aC5mbG9vcigoZGlmZiAlIDYwMDAwKSAvIDEwMDApOwogICAgICAgIGlmICh0aGlzLmlzTWFya2V0T3BlbigpKSBlbC50ZXh0Q29udGVudCA9IGBQcsOzeGltYSBhY3R1YWxpemFjacOzbiBlbiAke219OiR7U3RyaW5nKHMpLnBhZFN0YXJ0KDIsICcwJyl9YDsKICAgICAgICBlbHNlIGVsLnRleHRDb250ZW50ID0gJ01lcmNhZG8gY2VycmFkbyc7CiAgICAgIH0sIDEwMDApOwogICAgfQoKICAgIF9zdG9wQ291bnRkb3duKCkgewogICAgICBjbGVhckludGVydmFsKHRoaXMuY291bnRkb3duVGltZXIpOwogICAgICB0aGlzLmNvdW50ZG93blRpbWVyID0gbnVsbDsKICAgIH0KICB9CgogIC8vIDYpIEzDs2dpY2EgZGUgY2FjaMOpCiAgZnVuY3Rpb24gc2F2ZUNhY2hlKGRhdGEpIHsKICAgIHRyeSB7CiAgICAgIHNlc3Npb25TdG9yYWdlLnNldEl0ZW0oQ0FDSEVfS0VZLCBKU09OLnN0cmluZ2lmeSh7CiAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLAogICAgICAgIG1lcENjbDogZGF0YS5tZXBDY2wsCiAgICAgICAgZmNpUmVudGFGaWphOiBkYXRhLmZjaVJlbnRhRmlqYSwKICAgICAgICBmY2lSZW50YUZpamFQZW51bHRpbW86IGRhdGEuZmNpUmVudGFGaWphUGVudWx0aW1vCiAgICAgIH0pKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgY29uc29sZS5lcnJvcignW1JhZGFyTUVQXSBubyBzZSBwdWRvIGd1YXJkYXIgY2FjaGUnLCBlKTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIGxvYWRDYWNoZSgpIHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHJhdyA9IHNlc3Npb25TdG9yYWdlLmdldEl0ZW0oQ0FDSEVfS0VZKTsKICAgICAgaWYgKCFyYXcpIHJldHVybiBudWxsOwogICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdyk7CiAgICAgIGlmICghcGFyc2VkLnRpbWVzdGFtcCB8fCBEYXRlLm5vdygpIC0gcGFyc2VkLnRpbWVzdGFtcCA+IENBQ0hFX1RUTF9NUykgcmV0dXJuIG51bGw7CiAgICAgIHJldHVybiBwYXJzZWQ7CiAgICB9IGNhdGNoIChlKSB7CiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tSYWRhck1FUF0gY2FjaGUgaW52w6FsaWRhJywgZSk7CiAgICAgIHJldHVybiBudWxsOwogICAgfQogIH0KCiAgZnVuY3Rpb24gY2xhbXBEcmF3ZXJXaWR0aChweCkgewogICAgcmV0dXJuIE1hdGgubWF4KERSQVdFUl9NSU5fVywgTWF0aC5taW4oRFJBV0VSX01BWF9XLCBNYXRoLnJvdW5kKHB4KSkpOwogIH0KICBmdW5jdGlvbiBzYXZlRHJhd2VyV2lkdGgocHgpIHsKICAgIHRyeSB7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKERSQVdFUl9XSURUSF9LRVksIFN0cmluZyhjbGFtcERyYXdlcldpZHRoKHB4KSkpOyB9IGNhdGNoIHt9CiAgfQogIGZ1bmN0aW9uIGxvYWREcmF3ZXJXaWR0aCgpIHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHJhdyA9IE51bWJlcihsb2NhbFN0b3JhZ2UuZ2V0SXRlbShEUkFXRVJfV0lEVEhfS0VZKSk7CiAgICAgIHJldHVybiBOdW1iZXIuaXNGaW5pdGUocmF3KSA/IGNsYW1wRHJhd2VyV2lkdGgocmF3KSA6IG51bGw7CiAgICB9IGNhdGNoIHsKICAgICAgcmV0dXJuIG51bGw7CiAgICB9CiAgfQogIGZ1bmN0aW9uIGFwcGx5RHJhd2VyV2lkdGgocHgsIHBlcnNpc3QgPSBmYWxzZSkgewogICAgaWYgKHdpbmRvdy5pbm5lcldpZHRoIDw9IDkwMCkgcmV0dXJuOwogICAgY29uc3QgbmV4dCA9IGNsYW1wRHJhd2VyV2lkdGgocHgpOwogICAgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LnN0eWxlLnNldFByb3BlcnR5KCctLWRyYXdlci13JywgYCR7bmV4dH1weGApOwogICAgaWYgKHBlcnNpc3QpIHNhdmVEcmF3ZXJXaWR0aChuZXh0KTsKICB9CiAgZnVuY3Rpb24gaW5pdERyYXdlcldpZHRoKCkgewogICAgY29uc3Qgc2F2ZWQgPSBsb2FkRHJhd2VyV2lkdGgoKTsKICAgIGlmIChzYXZlZCAhPT0gbnVsbCkgYXBwbHlEcmF3ZXJXaWR0aChzYXZlZCwgZmFsc2UpOwogIH0KICBmdW5jdGlvbiBiaW5kRHJhd2VyUmVzaXplKCkgewogICAgaWYgKHN0YXRlLmRyYXdlclJlc2l6ZUJvdW5kKSByZXR1cm47CiAgICBjb25zdCBoYW5kbGUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZHJhd2VyLXJlc2l6ZXInKTsKICAgIGNvbnN0IGRyYXdlciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdkcmF3ZXInKTsKICAgIGlmICghaGFuZGxlIHx8ICFkcmF3ZXIpIHJldHVybjsKICAgIHN0YXRlLmRyYXdlclJlc2l6ZUJvdW5kID0gdHJ1ZTsKICAgIGhhbmRsZS5hZGRFdmVudExpc3RlbmVyKCdwb2ludGVyZG93bicsIChldmVudCkgPT4gewogICAgICBpZiAod2luZG93LmlubmVyV2lkdGggPD0gOTAwIHx8IGV2ZW50LmJ1dHRvbiAhPT0gMCkgcmV0dXJuOwogICAgICBjb25zdCBzdGFydFggPSBldmVudC5jbGllbnRYOwogICAgICBjb25zdCBzdGFydFdpZHRoID0gZHJhd2VyLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpLndpZHRoOwogICAgICBoYW5kbGUuY2xhc3NMaXN0LmFkZCgnYWN0aXZlJyk7CiAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7CiAgICAgIGNvbnN0IG9uTW92ZSA9IChtb3ZlRXZlbnQpID0+IHsKICAgICAgICBjb25zdCBkZWx0YSA9IG1vdmVFdmVudC5jbGllbnRYIC0gc3RhcnRYOwogICAgICAgIGFwcGx5RHJhd2VyV2lkdGgoc3RhcnRXaWR0aCAtIGRlbHRhLCBmYWxzZSk7CiAgICAgIH07CiAgICAgIGNvbnN0IG9uVXAgPSAoKSA9PiB7CiAgICAgICAgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJtb3ZlJywgb25Nb3ZlKTsKICAgICAgICB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcigncG9pbnRlcnVwJywgb25VcCk7CiAgICAgICAgaGFuZGxlLmNsYXNzTGlzdC5yZW1vdmUoJ2FjdGl2ZScpOwogICAgICAgIGNvbnN0IHdpZHRoID0gZHJhd2VyLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpLndpZHRoOwogICAgICAgIGFwcGx5RHJhd2VyV2lkdGgod2lkdGgsIHRydWUpOwogICAgICB9OwogICAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigncG9pbnRlcm1vdmUnLCBvbk1vdmUpOwogICAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigncG9pbnRlcnVwJywgb25VcCk7CiAgICB9KTsKICB9CgogIGZ1bmN0aW9uIGhpZGVTbWFydFRpcCgpIHsKICAgIGNvbnN0IHRpcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzbWFydC10aXAnKTsKICAgIGlmICghdGlwKSByZXR1cm47CiAgICB0aXAuY2xhc3NMaXN0LnJlbW92ZSgnc2hvdycpOwogICAgdGlwLnNldEF0dHJpYnV0ZSgnYXJpYS1oaWRkZW4nLCAndHJ1ZScpOwogIH0KICBmdW5jdGlvbiBzaG93U21hcnRUaXAoYW5jaG9yKSB7CiAgICBjb25zdCB0aXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc21hcnQtdGlwJyk7CiAgICBpZiAoIXRpcCB8fCAhYW5jaG9yKSByZXR1cm47CiAgICBjb25zdCB0ZXh0ID0gYW5jaG9yLmdldEF0dHJpYnV0ZSgnZGF0YS10Jyk7CiAgICBpZiAoIXRleHQpIHJldHVybjsKICAgIHRpcC50ZXh0Q29udGVudCA9IHRleHQ7CiAgICB0aXAuY2xhc3NMaXN0LmFkZCgnc2hvdycpOwogICAgdGlwLnNldEF0dHJpYnV0ZSgnYXJpYS1oaWRkZW4nLCAnZmFsc2UnKTsKCiAgICBjb25zdCBtYXJnaW4gPSA4OwogICAgY29uc3QgcmVjdCA9IGFuY2hvci5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsKICAgIGNvbnN0IHRpcFJlY3QgPSB0aXAuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7CiAgICBsZXQgbGVmdCA9IHJlY3QubGVmdDsKICAgIGlmIChsZWZ0ICsgdGlwUmVjdC53aWR0aCArIG1hcmdpbiA+IHdpbmRvdy5pbm5lcldpZHRoKSBsZWZ0ID0gd2luZG93LmlubmVyV2lkdGggLSB0aXBSZWN0LndpZHRoIC0gbWFyZ2luOwogICAgaWYgKGxlZnQgPCBtYXJnaW4pIGxlZnQgPSBtYXJnaW47CiAgICBsZXQgdG9wID0gcmVjdC5ib3R0b20gKyA4OwogICAgaWYgKHRvcCArIHRpcFJlY3QuaGVpZ2h0ICsgbWFyZ2luID4gd2luZG93LmlubmVySGVpZ2h0KSB0b3AgPSBNYXRoLm1heChtYXJnaW4sIHJlY3QudG9wIC0gdGlwUmVjdC5oZWlnaHQgLSA4KTsKICAgIHRpcC5zdHlsZS5sZWZ0ID0gYCR7TWF0aC5yb3VuZChsZWZ0KX1weGA7CiAgICB0aXAuc3R5bGUudG9wID0gYCR7TWF0aC5yb3VuZCh0b3ApfXB4YDsKICB9CiAgZnVuY3Rpb24gaW5pdFNtYXJ0VGlwcygpIHsKICAgIGlmIChzdGF0ZS5zbWFydFRpcEJvdW5kKSByZXR1cm47CiAgICBzdGF0ZS5zbWFydFRpcEJvdW5kID0gdHJ1ZTsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50aXAudGlwLWRvd24nKS5mb3JFYWNoKChlbCkgPT4gewogICAgICBlbC5hZGRFdmVudExpc3RlbmVyKCdtb3VzZWVudGVyJywgKCkgPT4gc2hvd1NtYXJ0VGlwKGVsKSk7CiAgICAgIGVsLmFkZEV2ZW50TGlzdGVuZXIoJ2ZvY3VzJywgKCkgPT4gc2hvd1NtYXJ0VGlwKGVsKSk7CiAgICAgIGVsLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKGV2ZW50KSA9PiB7CiAgICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTsKICAgICAgICBzaG93U21hcnRUaXAoZWwpOwogICAgICB9KTsKICAgICAgZWwuYWRkRXZlbnRMaXN0ZW5lcignbW91c2VsZWF2ZScsIGhpZGVTbWFydFRpcCk7CiAgICAgIGVsLmFkZEV2ZW50TGlzdGVuZXIoJ2JsdXInLCBoaWRlU21hcnRUaXApOwogICAgfSk7CiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcignc2Nyb2xsJywgaGlkZVNtYXJ0VGlwLCB0cnVlKTsKICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdyZXNpemUnLCAoKSA9PiB7CiAgICAgIGhpZGVTbWFydFRpcCgpOwogICAgICBpbml0RHJhd2VyV2lkdGgoKTsKICAgIH0pOwogICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoZXZlbnQpID0+IHsKICAgICAgaWYgKCEoZXZlbnQudGFyZ2V0IGluc3RhbmNlb2YgRWxlbWVudCkpIHJldHVybjsKICAgICAgaWYgKCFldmVudC50YXJnZXQuY2xvc2VzdCgnLnRpcC50aXAtZG93bicpICYmICFldmVudC50YXJnZXQuY2xvc2VzdCgnI3NtYXJ0LXRpcCcpKSBoaWRlU21hcnRUaXAoKTsKICAgIH0pOwogIH0KCiAgLy8gNykgSW5pY2lhbGl6YWNpw7NuCiAgc3RhcnRGcmVzaFRpY2tlcigpOwogIGluaXREcmF3ZXJXaWR0aCgpOwogIGJpbmREcmF3ZXJSZXNpemUoKTsKICBpbml0U21hcnRUaXBzKCk7CiAgZnVuY3Rpb24gdG9nZ2xlRHJhd2VyKCkgewogICAgY29uc3QgZHJhd2VyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2RyYXdlcicpOwogICAgY29uc3Qgd3JhcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdib2R5V3JhcCcpOwogICAgY29uc3QgYnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2J0blRhc2FzJyk7CiAgICBjb25zdCBvdmwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnb3ZlcmxheScpOwogICAgY29uc3QgaXNPcGVuID0gZHJhd2VyLmNsYXNzTGlzdC5jb250YWlucygnb3BlbicpOwogICAgZHJhd2VyLmNsYXNzTGlzdC50b2dnbGUoJ29wZW4nLCAhaXNPcGVuKTsKICAgIHdyYXAuY2xhc3NMaXN0LnRvZ2dsZSgnZHJhd2VyLW9wZW4nLCAhaXNPcGVuKTsKICAgIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKCdhY3RpdmUnLCAhaXNPcGVuKTsKICAgIG92bC5jbGFzc0xpc3QudG9nZ2xlKCdzaG93JywgIWlzT3Blbik7CiAgfQoKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcucGlsbFtkYXRhLWZpbHRlcl0nKS5mb3JFYWNoKChwKSA9PiB7CiAgICBwLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gYXBwbHlGaWx0ZXIocC5kYXRhc2V0LmZpbHRlcikpOwogIH0pOwogIGNvbnN0IGNzdkJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdidG4tZG93bmxvYWQtY3N2Jyk7CiAgaWYgKGNzdkJ0bikgY3N2QnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgZG93bmxvYWRIaXN0b3J5Q3N2KTsKICBjb25zdCBmY2lTZWFyY2ggPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLXNlYXJjaCcpOwogIGlmIChmY2lTZWFyY2gpIHsKICAgIGZjaVNlYXJjaC5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsICgpID0+IHsKICAgICAgc3RhdGUuZmNpUXVlcnkgPSBmY2lTZWFyY2gudmFsdWUgfHwgJyc7CiAgICAgIHN0YXRlLmZjaVBhZ2UgPSAxOwogICAgICByZW5kZXJGY2lSZW50YUZpamEoKTsKICAgIH0pOwogIH0KICBjb25zdCBmY2lQcmV2ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZjaS1wcmV2Jyk7CiAgaWYgKGZjaVByZXYpIHsKICAgIGZjaVByZXYuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgIHN0YXRlLmZjaVBhZ2UgPSBNYXRoLm1heCgxLCBzdGF0ZS5mY2lQYWdlIC0gMSk7CiAgICAgIHJlbmRlckZjaVJlbnRhRmlqYSgpOwogICAgfSk7CiAgfQogIGNvbnN0IGZjaU5leHQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmNpLW5leHQnKTsKICBpZiAoZmNpTmV4dCkgewogICAgZmNpTmV4dC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgc3RhdGUuZmNpUGFnZSArPSAxOwogICAgICByZW5kZXJGY2lSZW50YUZpamEoKTsKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gdG9nZ2xlR2xvcygpIHsKICAgIGNvbnN0IGdyaWQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZ2xvc0dyaWQnKTsKICAgIGNvbnN0IGFycm93ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2dsb3NBcnJvdycpOwogICAgY29uc3Qgb3BlbiA9IGdyaWQuY2xhc3NMaXN0LnRvZ2dsZSgnb3BlbicpOwogICAgYXJyb3cudGV4dENvbnRlbnQgPSBvcGVuID8gJ+KWtCcgOiAn4pa+JzsKICB9CgogIGNvbnN0IHJldHJ5QnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Vycm9yLXJldHJ5LWJ0bicpOwogIGlmIChyZXRyeUJ0bikgewogICAgcmV0cnlCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7CiAgICAgIGlmICh3aW5kb3cuc2NoZWR1bGVyKSB3aW5kb3cuc2NoZWR1bGVyLnJlc3VtZSgpOwogICAgICBmZXRjaEFsbCh7IG1hbnVhbDogdHJ1ZSB9KTsKICAgIH0pOwogIH0KCiAgY29uc3QgY2FjaGVkID0gbG9hZENhY2hlKCk7CiAgaW5pdEhpc3RvcnlDb2x1bW5XaWR0aHMoKTsKICBiaW5kSGlzdG9yeUNvbHVtblJlc2l6ZSgpOwogIGlmIChjYWNoZWQpIHsKICAgIHN0YXRlLmxhc3RNZXBQYXlsb2FkID0gY2FjaGVkLm1lcENjbDsKICAgIHJlbmRlckZjaVJlbnRhRmlqYShjYWNoZWQuZmNpUmVudGFGaWphLCBjYWNoZWQuZmNpUmVudGFGaWphUGVudWx0aW1vKTsKICAgIHJlbmRlck1lcENjbChjYWNoZWQubWVwQ2NsKTsKICAgIHJlbmRlck1ldHJpY3MyNGgoY2FjaGVkLm1lcENjbCk7CiAgICByZW5kZXJUcmVuZChjYWNoZWQubWVwQ2NsKTsKICAgIHJlbmRlckhpc3RvcnkoY2FjaGVkLm1lcENjbCk7CiAgICBjb25zdCBjYWNoZWRSb290ID0gZXh0cmFjdFJvb3QoY2FjaGVkLm1lcENjbCk7CiAgICBzdGF0ZS5zb3VyY2VUc01zID0gdG9OdW1iZXIoY2FjaGVkUm9vdD8uc291cmNlU3RhdHVzPy5sYXRlc3RTb3VyY2VUc01zKQogICAgICA/PyB0b051bWJlcihjYWNoZWRSb290Py5jdXJyZW50Py5tZXBUc01zKQogICAgICA/PyB0b051bWJlcihjYWNoZWRSb290Py5jdXJyZW50Py5jY2xUc01zKQogICAgICAK`;

function decodeBase64Utf8(b64) {
  const compact = b64.replace(/\s+/g, "");
  const binary = atob(compact);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function renderDashboardHtml() {
  return decodeBase64Utf8(DASHBOARD_HTML_B64);
}
