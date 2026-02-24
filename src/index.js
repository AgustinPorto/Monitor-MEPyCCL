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

  const previous = (await loadState(env)) || buildEmptyState(now);
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
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
  <style>
    :root{--bg-1:#f4f7fb;--bg-2:#e6edf8;--ink:#0f172a;--muted:#475569;--card:#ffffff;--line:#d9e2ef;--brand:#0f4c81;--warn-bg:#fff6e8;--warn-line:#f3c17a;--warn-ink:#7a4e12}
    *{box-sizing:border-box} body{margin:0;min-height:100vh;font-family:"IBM Plex Sans",sans-serif;color:var(--ink);background:radial-gradient(1300px 500px at -10% -20%, #d9e6fa 0%, transparent 60%),radial-gradient(900px 500px at 110% -10%, #d9f5ef 0%, transparent 55%),linear-gradient(180deg,var(--bg-1) 0%, var(--bg-2) 100%);padding:20px}
    .card{max-width:980px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:20px;box-shadow:0 20px 40px rgba(15,23,42,.08);padding:22px}
    h1,h2,h3{font-family:"Sora",sans-serif;margin:0} h1{font-size:28px;letter-spacing:-.02em} h2{font-size:20px;margin-top:20px}
    .top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap} .updated{color:var(--muted);font-size:13px;margin-top:6px}
    .pills{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px} .status{display:inline-block;padding:8px 14px;border-radius:999px;color:#fff;font-weight:700;background:#7c3f00;font-family:"Sora",sans-serif}
    .chip{display:inline-block;padding:6px 10px;border-radius:999px;color:#fff;font-size:12px;font-weight:700;background:#64748b}
    .tabs{display:flex;gap:8px;margin-top:16px;border-bottom:1px solid var(--line);padding-bottom:10px}
    .tab,.notify-btn{border:1px solid var(--line);background:#f8fbff;color:var(--ink);border-radius:10px;padding:8px 12px;font-weight:600;cursor:pointer}
    .tab.active{background:var(--brand);color:#fff;border-color:var(--brand)} .notify-btn.on{background:#0f7a36;color:#fff;border-color:#0f7a36}
    .panel{display:none}.panel.active{display:block}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:14px}.grid.kpis{grid-template-columns:repeat(3,minmax(0,1fr))}
    .box{background:linear-gradient(180deg,#fff 0%, #f7fbff 100%);border:1px solid var(--line);border-radius:12px;padding:12px;min-height:86px}
    .k{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.8px;font-weight:600}.v{font-size:24px;font-weight:800;margin-top:6px;font-family:"Sora",sans-serif}.muted{font-size:12px;color:var(--muted);margin-top:5px}
    .warn{background:var(--warn-bg);border:1px solid var(--warn-line);border-radius:12px;padding:10px;margin-top:10px;color:var(--warn-ink)}
    .chart-toolbar{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-top:10px}
    .range-btns{display:flex;gap:6px;flex-wrap:wrap}
    .range-btn{border:1px solid var(--line);background:#f8fbff;color:var(--ink);border-radius:999px;padding:6px 10px;font-size:12px;font-weight:600;cursor:pointer}
    .range-btn.active{background:#0f4c81;color:#fff;border-color:#0f4c81}
    .chart-wrap{position:relative;margin-top:10px}
    .chart-tooltip{position:absolute;pointer-events:none;background:#0f172a;color:#fff;padding:8px 10px;border-radius:10px;font-size:12px;line-height:1.35;opacity:0;transform:translate(-50%,-120%);transition:opacity .12s ease;white-space:nowrap;z-index:10}
    canvas{display:block;width:100%;height:320px;background:#fff;border:1px solid var(--line);border-radius:12px}
    table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px} th,td{border-bottom:1px solid var(--line);padding:9px;text-align:left} th{background:#f4f8fd;color:#334155}
    .foot{font-size:13px;color:var(--muted);margin-top:14px}.guide-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:14px}
    .guide-item{border:1px solid var(--line);background:#fbfdff;border-radius:12px;padding:12px}.guide-item h3{font-size:15px;margin-bottom:6px}.guide-item p{margin:0;color:#334155;font-size:14px;line-height:1.35}
    @media (max-width:860px){.grid,.grid.kpis,.guide-grid{grid-template-columns:1fr} h1{font-size:24px}}
  </style>
</head>
<body>
  <div class="card">
    <div class="top">
      <div>
        <h1>Radar MEP vs CCL</h1>
        <div class="updated" id="updated">Actualizado: cargando...</div>
        <div class="pills">
          <span class="chip" id="marketChip">Mercado ARG: ...</span>
          <span class="chip" id="sourceChip">Fuente: ...</span>
          <span class="status" id="statusPill">...</span>
        </div>
      </div>
      <div class="box" style="min-width:220px">
        <div class="k">Frescura dato fuente</div>
        <div class="v" id="freshness">N/D</div>
        <div class="muted">Minutos desde último timestamp MEP/CCL</div>
      </div>
    </div>

    <div class="tabs">
      <button class="tab active" data-tab="overview">Panel</button>
      <button class="tab" data-tab="guide">Glosario</button>
      <button class="notify-btn" id="notifyBtn">Activar notificaciones</button>
    </div>

    <section class="panel active" id="panel-overview">
      <div id="warnArea"></div>
      <div class="grid">
        <div class="box"><div class="k">Última actualización exitosa</div><div class="v" id="opLastOk">N/D</div><div class="muted">Última corrida con fuente OK</div></div>
        <div class="box"><div class="k">Próxima corrida estimada</div><div class="v" id="opNextRun">N/D</div><div class="muted">Cron de Cloudflare (GMT-3, Buenos Aires)</div></div>
      </div>
      <div class="grid kpis">
        <div class="box"><div class="k">Muestras en 24h</div><div class="v" id="mCount">0</div><div class="muted">Registros del período</div></div>
        <div class="box"><div class="k">Veces en SIMILAR (24h)</div><div class="v" id="mSimilar">0</div><div class="muted">Momentos en zona similar</div></div>
        <div class="box"><div class="k">Brecha % promedio (24h)</div><div class="v" id="mAvg">N/D</div><div class="muted">Promedio porcentual</div></div>
      </div>

      <div class="grid">
        <div class="box"><div class="k">MEP venta</div><div class="v" id="mep">N/D</div><div class="muted" id="mepRef">Ref: s/dato</div></div>
        <div class="box"><div class="k">CCL venta</div><div class="v" id="ccl">N/D</div><div class="muted" id="cclRef">Ref: s/dato</div></div>
        <div class="box"><div class="k">Diferencia absoluta</div><div class="v" id="absDiff">N/D</div></div>
        <div class="box"><div class="k">Diferencia porcentual</div><div class="v" id="pctDiff">N/D</div></div>
        <div class="box"><div class="k">Brecha % mínima (24h)</div><div class="v" id="mMin">N/D</div></div>
        <div class="box"><div class="k">Brecha % máxima (24h)</div><div class="v" id="mMax">N/D</div></div>
      </div>

      <h2 style="margin-top:18px">Tendencia reciente</h2>
      <div class="chart-toolbar">
        <div class="range-btns">
          <button class="range-btn" data-range="20">20 puntos</button>
          <button class="range-btn active" data-range="40">40 puntos</button>
          <button class="range-btn" data-range="all">Todo</button>
        </div>
        <div class="muted">Hover para ver valores exactos</div>
      </div>
      <div class="chart-wrap">
        <canvas id="trendChart"></canvas>
        <div id="chartTooltip" class="chart-tooltip"></div>
      </div>
      <h2 style="margin-top:18px">Historial</h2>
      <table>
        <thead><tr><th>Hora</th><th>MEP</th><th>CCL</th><th>Dif $</th><th>Dif %</th><th>Estado</th></tr></thead>
        <tbody id="historyRows"></tbody>
      </table>
      <p class="foot" id="ruleText"></p>
      <p class="foot">Fuente: <a id="sourceLink" href="#" target="_blank" rel="noopener noreferrer">dolarito.ar</a></p>
    </section>

    <section class="panel" id="panel-guide">
      <h2>Qué significa cada dato</h2>
      <div class="guide-grid">
        <article class="guide-item"><h3>MEP venta</h3><p>Precio de venta del dólar MEP obtenido de la fuente.</p></article>
        <article class="guide-item"><h3>CCL venta</h3><p>Precio de venta del dólar CCL para comparación de brecha.</p></article>
        <article class="guide-item"><h3>Diferencia absoluta</h3><p>Distancia en pesos entre CCL y MEP: <strong>|MEP - CCL|</strong>.</p></article>
        <article class="guide-item"><h3>Diferencia porcentual</h3><p>Brecha relativa contra el promedio entre ambos valores.</p></article>
        <article class="guide-item"><h3>Estado SIMILAR / NO SIMILAR</h3><p>SIMILAR cuando se cumple el umbral de pesos o porcentaje.</p></article>
        <article class="guide-item"><h3>Frescura del dato</h3><p>Tiempo desde último timestamp recibido de la fuente.</p></article>
        <article class="guide-item"><h3>Métricas 24h</h3><p>Resumen de muestras, veces similar y brecha mínima/máxima/promedio.</p></article>
        <article class="guide-item"><h3>Mercado ARG</h3><p>Ventana: lunes a viernes de 10:30 a 17:59 (GMT-3, Buenos Aires).</p></article>
      </div>
    </section>
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
      if (!("Notification" in window)) { btn.textContent = "Notificaciones no soportadas"; btn.disabled = true; return; }
      if (Notification.permission === "granted") { btn.textContent = "Notificaciones activas"; btn.classList.add("on"); return; }
      if (Notification.permission === "denied") { btn.textContent = "Notificaciones bloqueadas"; return; }
      btn.textContent = "Activar notificaciones";
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

    function render(state) {
      latestState = state;
      setText("updated", "Actualizado: " + (state.updatedAtHumanArt || "N/D"));

      const marketChip = document.getElementById("marketChip");
      marketChip.textContent = "Mercado ARG: " + (state.market?.status || "N/D");
      marketChip.style.background = state.market?.isOpen ? "#0f7a36" : "#7c3f00";

      const sourceChip = document.getElementById("sourceChip");
      sourceChip.textContent = "Fuente: " + (state.sourceStatus?.text || "N/D");
      sourceChip.style.background = state.sourceStatus?.ok ? "#0f7a36" : "#a61b1b";

      const statusPill = document.getElementById("statusPill");
      statusPill.textContent = state.status?.text || "N/D";
      statusPill.style.background = state.status?.color || "#7c3f00";

      setText("freshness", state.sourceStatus?.freshLabel || "N/D");
      setText("opLastOk", state.operational?.lastSuccessAtHumanArt || "N/D");
      setText("opNextRun", state.operational?.nextRunAtHumanArt || "N/D");
      setText("mCount", String(state.metrics24h?.count ?? 0));
      setText("mSimilar", String(state.metrics24h?.similarCount ?? 0));
      setText("mAvg", fmtPct(state.metrics24h?.avgPct));
      setText("mMin", fmtPct(state.metrics24h?.minPct));
      setText("mMax", fmtPct(state.metrics24h?.maxPct));

      setText("mep", fmtMoney(state.current?.mep));
      setText("ccl", fmtMoney(state.current?.ccl));
      setText("mepRef", "Ref: " + (state.current?.mepTsHuman || "s/dato"));
      setText("cclRef", "Ref: " + (state.current?.cclTsHuman || "s/dato"));
      setText("absDiff", fmtMoney(state.current?.absDiff));
      setText("pctDiff", fmtPct(state.current?.pctDiff));

      setText("ruleText", "Condición de similitud: diferencia <= " + state.thresholds.maxAbsDiffArs + " ARS o <= " + state.thresholds.maxPctDiff + "%");
      const sourceLink = document.getElementById("sourceLink");
      sourceLink.href = state.sourceUrl || "https://www.dolarito.ar/cotizacion/dolar-hoy";
      sourceLink.textContent = sourceLink.href;

      const warnings = [];
      if (!state.sourceStatus?.ok) warnings.push("No se pudieron obtener datos nuevos. Se muestra el último estado disponible.");
      if (state.sourceStatus?.freshWarn) warnings.push("El dato de fuente está desactualizado (> 60 min).");
      const warnArea = document.getElementById("warnArea");
      warnArea.innerHTML = warnings.map((w) => '<div class="warn">' + w + '</div>').join("");

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
      rows.innerHTML = "";
      const visible = history.slice(-20).reverse();
      for (const r of visible) {
        const tr = document.createElement("tr");
        tr.innerHTML = "<td>" + r.label + "</td>"
          + "<td>" + fmtMoney(Number(r.mep)) + "</td>"
          + "<td>" + fmtMoney(Number(r.ccl)) + "</td>"
          + "<td>" + fmtMoney(Number(r.abs_diff)) + "</td>"
          + "<td>" + fmtPct(Number(r.pct_diff)) + "</td>"
          + "<td>" + (r.similar ? "SIMILAR" : "NO") + "</td>";
        rows.appendChild(tr);
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
        ctx.fillStyle = "#666";
        ctx.font = "14px Arial";
        ctx.fillText("Sin historial disponible", 20, 40);
        tooltip.style.opacity = "0";
        return;
      }

      const values = data.flatMap((d) => [Number(d.mep), Number(d.ccl)]).filter((n) => Number.isFinite(n));
      if (!values.length) return;

      const min = Math.min(...values) * 0.995;
      const max = Math.max(...values) * 1.005;
      const w = cssWidth;
      const h = cssHeight;
      const pad = 36;
      const x = (i) => pad + (i * (w - pad * 2)) / Math.max(data.length - 1, 1);
      const y = (v) => h - pad - ((v - min) * (h - pad * 2)) / Math.max(max - min, 1);

      ctx.strokeStyle = "#e5e7eb";
      ctx.lineWidth = 1;
      for (let i = 0; i < 4; i++) {
        const yy = pad + (i * (h - pad * 2)) / 3;
        ctx.beginPath(); ctx.moveTo(pad, yy); ctx.lineTo(w - pad, yy); ctx.stroke();
      }

      const drawLine = (key, color) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        data.forEach((d, i) => {
          const px = x(i), py = y(Number(d[key]));
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          if (key === "mep") chartHitboxes.push({ x: px, yMep: py, yCcl: y(Number(d.ccl)), i });
        });
        ctx.stroke();
      };
      drawLine("mep", "#0f7a36");
      drawLine("ccl", "#1d4ed8");

      // Hover indicator + labels
      if (chartHoverIndex >= 0 && chartHoverIndex < data.length) {
        const row = data[chartHoverIndex];
        const px = x(chartHoverIndex);
        const pyM = y(Number(row.mep));
        const pyC = y(Number(row.ccl));
        ctx.strokeStyle = "rgba(15,23,42,.35)";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(px, pad); ctx.lineTo(px, h - pad); ctx.stroke();

        ctx.fillStyle = "#0f7a36";
        ctx.beginPath(); ctx.arc(px, pyM, 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#1d4ed8";
        ctx.beginPath(); ctx.arc(px, pyC, 4, 0, Math.PI * 2); ctx.fill();
      }

      ctx.fillStyle = "#0f7a36"; ctx.fillRect(pad, 8, 10, 10); ctx.fillStyle = "#111"; ctx.fillText("MEP", pad + 14, 17);
      ctx.fillStyle = "#1d4ed8"; ctx.fillRect(pad + 60, 8, 10, 10); ctx.fillStyle = "#111"; ctx.fillText("CCL", pad + 74, 17);
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
        tooltip.innerHTML = row.label + "<br>MEP: $" + Number(row.mep).toFixed(2) + "<br>CCL: $" + Number(row.ccl).toFixed(2);
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

    document.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
        btn.classList.add("active");
        const t = btn.getAttribute("data-tab");
        document.getElementById("panel-overview").classList.toggle("active", t === "overview");
        document.getElementById("panel-guide").classList.toggle("active", t === "guide");
      });
    });

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
