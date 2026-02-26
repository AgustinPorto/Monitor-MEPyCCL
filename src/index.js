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
const EXTRAS_KEY = "mep_ccl_extras_v1";
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

    if (path === "/api/extras") {
      let extras = await loadExtras(env);
      if (!extras) {
        extras = await refreshMarketExtras(env, null, new Date());
      }
      return jsonResponse(extras || buildEmptyExtras(new Date()), false);
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
  const previousExtras = await loadExtras(env);
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

  await refreshMarketExtras(env, previousExtras, now);

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

function buildEmptyExtras(now) {
  return {
    updatedAtIso: now.toISOString(),
    updatedAtHumanArt: formatArtDate(now),
    sourceStatus: {
      cauciones: { ok: false, error: "sin_datos" },
      bonos: { ok: false, error: "sin_datos" },
      letras: { ok: false, error: "sin_datos" },
    },
    cauciones: null,
    bonos: null,
    letras: null,
  };
}

async function loadExtras(env) {
  const raw = await env.MONITOR_KV.get(EXTRAS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveExtras(env, extras) {
  await env.MONITOR_KV.put(EXTRAS_KEY, JSON.stringify(extras));
}

async function fetchJsonNoAuth(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; mep-ccl-monitor/1.0)",
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "es-AR,es;q=0.9,en;q=0.8",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function refreshMarketExtras(env, previousExtras, now) {
  const prev = previousExtras && typeof previousExtras === "object" ? previousExtras : buildEmptyExtras(now);
  const next = {
    ...prev,
    updatedAtIso: now.toISOString(),
    updatedAtHumanArt: formatArtDate(now),
    sourceStatus: {
      cauciones: { ...(prev.sourceStatus?.cauciones || { ok: false, error: "sin_datos" }) },
      bonos: { ...(prev.sourceStatus?.bonos || { ok: false, error: "sin_datos" }) },
      letras: { ...(prev.sourceStatus?.letras || { ok: false, error: "sin_datos" }) },
    },
  };

  const targets = [
    { key: "cauciones", url: "https://dolarito.ar/api/cauciones" },
    { key: "bonos", url: "https://dolarito.ar/api/bonos" },
    { key: "letras", url: "https://dolarito.ar/api/letras" },
  ];

  await Promise.all(
    targets.map(async ({ key, url }) => {
      try {
        const payload = await fetchJsonNoAuth(url);
        next[key] = payload;
        next.sourceStatus[key] = { ok: true, error: null };
      } catch (error) {
        next.sourceStatus[key] = {
          ok: false,
          error: sanitizeError(error),
        };
      }
    }),
  );

  // Fallback gratuito: si alguna API no responde, intentamos extraer del HTML público
  // de dolarito.ar/cotizacion/dolar-hoy y guardamos lo último válido en KV.
  const missing = targets
    .map((t) => t.key)
    .filter((k) => !next.sourceStatus[k]?.ok || !next[k]);
  if (missing.length) {
    try {
      const html = await fetchSourceHtml(SOURCE_URL);
      const embedded = extractEmbeddedSourceData(html);
      if (missing.includes("cauciones") && embedded.cauciones) {
        next.cauciones = embedded.cauciones;
        next.sourceStatus.cauciones = { ok: true, error: null };
      }
      if (missing.includes("bonos") && embedded.bonos) {
        next.bonos = embedded.bonos;
        next.sourceStatus.bonos = { ok: true, error: null };
      }
      if (missing.includes("letras") && embedded.letras) {
        next.letras = embedded.letras;
        next.sourceStatus.letras = { ok: true, error: null };
      }
    } catch (error) {
      // Conservamos el último dato válido previo.
      console.log("[RadarMEP] extras fallback html error:", sanitizeError(error));
    }
  }

  await saveExtras(env, next);
  return next;
}

function extractEmbeddedSourceData(html) {
  const out = { cauciones: null, bonos: null, letras: null };
  if (typeof html !== "string" || !html.trim()) return out;

  // 1) Intento directo con JSON embebido sin escapar.
  out.cauciones = parseEmbeddedByKey(html, "cauciones");
  out.bonos = parseEmbeddedByKey(html, "bonos");
  out.letras = parseEmbeddedByKey(html, "letras");

  // 2) Intento sobre JSON escapado (\"key\": ...)
  if (!out.cauciones) out.cauciones = parseEmbeddedByKeyEscaped(html, "cauciones");
  if (!out.bonos) out.bonos = parseEmbeddedByKeyEscaped(html, "bonos");
  if (!out.letras) out.letras = parseEmbeddedByKeyEscaped(html, "letras");

  return out;
}

function parseEmbeddedByKey(html, key) {
  const objectRegex = new RegExp(`"${key}"\\s*:\\s*(\\{[\\s\\S]*?\\})`, "i");
  const arrayRegex = new RegExp(`"${key}"\\s*:\\s*(\\[[\\s\\S]*?\\])`, "i");
  const om = html.match(objectRegex);
  if (om) {
    const parsed = safeJsonParse(sliceBalancedJson(om[1], "{", "}"));
    if (parsed) return parsed;
  }
  const am = html.match(arrayRegex);
  if (am) {
    const parsed = safeJsonParse(sliceBalancedJson(am[1], "[", "]"));
    if (parsed) return parsed;
  }
  return null;
}

function parseEmbeddedByKeyEscaped(html, key) {
  const objectRegex = new RegExp(`\\\\"${key}\\\\\"\\s*:\\s*(\\{[\\s\\S]*?\\})`, "i");
  const arrayRegex = new RegExp(`\\\\"${key}\\\\\"\\s*:\\s*(\\[[\\s\\S]*?\\])`, "i");
  const om = html.match(objectRegex);
  if (om) {
    const parsed = safeJsonParse(unescapeEscapedJson(sliceBalancedJson(om[1], "{", "}")));
    if (parsed) return parsed;
  }
  const am = html.match(arrayRegex);
  if (am) {
    const parsed = safeJsonParse(unescapeEscapedJson(sliceBalancedJson(am[1], "[", "]")));
    if (parsed) return parsed;
  }
  return null;
}

function safeJsonParse(value) {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function unescapeEscapedJson(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function sliceBalancedJson(value, open, close) {
  if (typeof value !== "string") return value;
  let depth = 0;
  let start = -1;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === open) {
      if (start < 0) start = i;
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0 && start >= 0) {
        return value.slice(start, i + 1);
      }
    }
  }
  return value;
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

const DASHBOARD_HTML_B64 = `PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVzIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAiPgo8dGl0bGU+UmFkYXIgTUVQL0NDTCDCtyBNZXJjYWRvIEFSRzwvdGl0bGU+CjxsaW5rIHJlbD0icHJlY29ubmVjdCIgaHJlZj0iaHR0cHM6Ly9mb250cy5nb29nbGVhcGlzLmNvbSI+CjxsaW5rIGhyZWY9Imh0dHBzOi8vZm9udHMuZ29vZ2xlYXBpcy5jb20vY3NzMj9mYW1pbHk9U3BhY2UrTW9ubzp3Z2h0QDQwMDs3MDAmZmFtaWx5PVN5bmU6d2dodEA0MDA7NjAwOzcwMDs4MDAmZGlzcGxheT1zd2FwIiByZWw9InN0eWxlc2hlZXQiPgo8c3R5bGU+Ci8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBUT0tFTlMK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCjpyb290IHsKICAtLWJnOiAgICAgICAjMDgwYjBlOwogIC0tc3VyZjogICAgICMwZjEzMTg7CiAgLS1zdXJmMjogICAgIzE2MWIyMjsKICAtLXN1cmYzOiAgICAjMWMyMzMwOwogIC0tYm9yZGVyOiAgICMxZTI1MzA7CiAgLS1ib3JkZXJCOiAgIzJhMzQ0NDsKCiAgLS1ncmVlbjogICAgIzAwZTY3NjsKICAtLWdyZWVuLWQ6ICByZ2JhKDAsMjMwLDExOCwuMDkpOwogIC0tZ3JlZW4tZzogIHJnYmEoMCwyMzAsMTE4LC4yMik7CiAgLS1yZWQ6ICAgICAgI2ZmNDc1NzsKICAtLXJlZC1kOiAgICByZ2JhKDI1NSw3MSw4NywuMDkpOwogIC0teWVsbG93OiAgICNmZmMgYzAwOwogIC0teWVsbG93OiAgICNmZmNjMDA7CiAgLS15ZWxsb3ctZDogcmdiYSgyNTUsMjA0LDAsLjA5KTsKCiAgLS1tZXA6ICAgICAgIzI5YjZmNjsKICAtLWNjbDogICAgICAjYjM5ZGRiOwogIC0tdGV4dDogICAgICNkZGU0ZWU7CiAgLS1tdXRlZDogICAgIzU1NjA3MDsKICAtLW11dGVkMjogICAjN2E4ZmE4OwoKICAtLW1vbm86ICdTcGFjZSBNb25vJywgbW9ub3NwYWNlOwogIC0tc2FuczogJ1N5bmUnLCBzYW5zLXNlcmlmOwoKICAtLWRyYXdlci13OiA0MDBweDsKICAtLWhlYWRlci1oOiA1NHB4Owp9CgoqLCAqOjpiZWZvcmUsICo6OmFmdGVyIHsgYm94LXNpemluZzogYm9yZGVyLWJveDsgbWFyZ2luOiAwOyBwYWRkaW5nOiAwOyB9CgpodG1sIHsgc2Nyb2xsLWJlaGF2aW9yOiBzbW9vdGg7IH0KCmJvZHkgewogIGJhY2tncm91bmQ6IHZhcigtLWJnKTsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgZm9udC1mYW1pbHk6IHZhcigtLW1vbm8pOwogIG1pbi1oZWlnaHQ6IDEwMHZoOwogIG92ZXJmbG93LXg6IGhpZGRlbjsKfQoKYm9keTo6YmVmb3JlIHsKICBjb250ZW50OiAnJzsKICBwb3NpdGlvbjogZml4ZWQ7IGluc2V0OiAwOwogIGJhY2tncm91bmQtaW1hZ2U6CiAgICBsaW5lYXItZ3JhZGllbnQocmdiYSg0MSwxODIsMjQ2LC4wMjUpIDFweCwgdHJhbnNwYXJlbnQgMXB4KSwKICAgIGxpbmVhci1ncmFkaWVudCg5MGRlZywgcmdiYSg0MSwxODIsMjQ2LC4wMjUpIDFweCwgdHJhbnNwYXJlbnQgMXB4KTsKICBiYWNrZ3JvdW5kLXNpemU6IDQ0cHggNDRweDsKICBwb2ludGVyLWV2ZW50czogbm9uZTsgei1pbmRleDogMDsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIExBWU9VVCBTSEVMTArilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLmFwcCB7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBtaW4taGVpZ2h0OiAxMDB2aDsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIEhFQURFUgrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KaGVhZGVyIHsKICBwb3NpdGlvbjogc3RpY2t5OyB0b3A6IDA7IHotaW5kZXg6IDIwMDsKICBoZWlnaHQ6IHZhcigtLWhlYWRlci1oKTsKICBiYWNrZ3JvdW5kOiByZ2JhKDgsMTEsMTQsLjkzKTsKICBiYWNrZHJvcC1maWx0ZXI6IGJsdXIoMThweCk7CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgcGFkZGluZzogMCAyMnB4OwogIGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsKfQoKLmxvZ28gewogIGZvbnQtZmFtaWx5OiB2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6IDgwMDsgZm9udC1zaXplOiAxNXB4OwogIGxldHRlci1zcGFjaW5nOiAuMDVlbTsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA5cHg7Cn0KCi5saXZlLWRvdCB7CiAgd2lkdGg6IDdweDsgaGVpZ2h0OiA3cHg7IGJvcmRlci1yYWRpdXM6IDUwJTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1ncmVlbik7CiAgYm94LXNoYWRvdzogMCAwIDhweCB2YXIoLS1ncmVlbik7CiAgYW5pbWF0aW9uOiBibGluayAyLjJzIGVhc2UtaW4tb3V0IGluZmluaXRlOwp9CkBrZXlmcmFtZXMgYmxpbmsgewogIDAlLDEwMCV7b3BhY2l0eToxO2JveC1zaGFkb3c6MCAwIDhweCB2YXIoLS1ncmVlbik7fQogIDUwJXtvcGFjaXR5Oi4zNTtib3gtc2hhZG93OjAgMCAzcHggdmFyKC0tZ3JlZW4pO30KfQoKLmhlYWRlci1yaWdodCB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogMTJweDsgfQoKLmZyZXNoLWJhZGdlIHsKICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDVweDsKICBmb250LXNpemU6IDExcHg7IGNvbG9yOiB2YXIoLS1tdXRlZDIpOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmYyKTsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOiAyMHB4OyBwYWRkaW5nOiAzcHggMTFweDsKfQouZnJlc2gtZG90IHsgd2lkdGg6NXB4O2hlaWdodDo1cHg7Ym9yZGVyLXJhZGl1czo1MCU7YmFja2dyb3VuZDp2YXIoLS1ncmVlbik7YW5pbWF0aW9uOmJsaW5rIDIuMnMgZWFzZS1pbi1vdXQgaW5maW5pdGU7IH0KLmZyZXNoLWJhZGdlLmZldGNoaW5nIHsgYW5pbWF0aW9uOiBiYWRnZVB1bHNlIDEuMnMgZWFzZS1pbi1vdXQgaW5maW5pdGU7IH0KLmZyZXNoLWJhZGdlLmVycm9yIHsgY29sb3I6I2ZmZDBkMDsgYm9yZGVyLWNvbG9yOnJnYmEoMjU1LDgyLDgyLC40NSk7IGJhY2tncm91bmQ6cmdiYSgyNTUsODIsODIsLjEyKTsgY3Vyc29yOnBvaW50ZXI7IH0KQGtleWZyYW1lcyBiYWRnZVB1bHNlIHsKICAwJSwxMDAlIHsgb3BhY2l0eToxOyB9CiAgNTAlIHsgb3BhY2l0eTouNjU7IH0KfQoKLnRhZy1tZXJjYWRvIHsKICBmb250LWZhbWlseTogdmFyKC0tc2Fucyk7IGZvbnQtc2l6ZToxMHB4OyBmb250LXdlaWdodDo3MDA7CiAgbGV0dGVyLXNwYWNpbmc6LjA4ZW07IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsKICBiYWNrZ3JvdW5kOnZhcigtLWdyZWVuKTsgY29sb3I6IzAwMDsKICBwYWRkaW5nOjNweCA5cHg7IGJvcmRlci1yYWRpdXM6NHB4Owp9Ci50YWctbWVyY2Fkby5jbG9zZWQgeyBiYWNrZ3JvdW5kOnZhcigtLW11dGVkKTsgY29sb3I6IzBhMGMwZjsgfQoKLmJ0biB7CiAgZm9udC1mYW1pbHk6IHZhcigtLXNhbnMpOyBmb250LXNpemU6MTFweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4wN2VtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7CiAgYm9yZGVyLXJhZGl1czo2cHg7IHBhZGRpbmc6NnB4IDE0cHg7IGN1cnNvcjpwb2ludGVyOwogIGJvcmRlcjpub25lOyB0cmFuc2l0aW9uOiBhbGwgLjE4czsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo2cHg7Cn0KLmJ0bi1hbGVydCB7IGJhY2tncm91bmQ6dmFyKC0tZ3JlZW4pOyBjb2xvcjojMDAwOyB9Ci5idG4tYWxlcnQ6aG92ZXIgeyBiYWNrZ3JvdW5kOiMwMGZmODg7IHRyYW5zZm9ybTp0cmFuc2xhdGVZKC0xcHgpOyB9CgouYnRuLXRhc2FzIHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMik7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyQik7CiAgY29sb3I6IHZhcigtLXRleHQpOwp9Ci5idG4tdGFzYXM6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmMyk7IGJvcmRlci1jb2xvcjogdmFyKC0tbXV0ZWQyKTsgfQouYnRuLXRhc2FzLmFjdGl2ZSB7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZjMpOwogIGJvcmRlci1jb2xvcjogdmFyKC0teWVsbG93KTsKICBjb2xvcjogdmFyKC0teWVsbG93KTsKfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIE1BSU4gKyBEUkFXRVIgTEFZT1VUCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwouYm9keS13cmFwIHsKICBmbGV4OiAxOwogIGRpc3BsYXk6IGZsZXg7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIHotaW5kZXg6IDE7CiAgdHJhbnNpdGlvbjogbm9uZTsKfQoKLm1haW4tY29udGVudCB7CiAgZmxleDogMTsKICBtYXgtd2lkdGg6IDEwMCU7CiAgcGFkZGluZzogMjJweCAyMnB4IDYwcHg7CiAgdHJhbnNpdGlvbjogbWFyZ2luLXJpZ2h0IC4zNXMgY3ViaWMtYmV6aWVyKC40LDAsLjIsMSk7Cn0KCi5ib2R5LXdyYXAuZHJhd2VyLW9wZW4gLm1haW4tY29udGVudCB7CiAgbWFyZ2luLXJpZ2h0OiB2YXIoLS1kcmF3ZXItdyk7Cn0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBEUkFXRVIK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5kcmF3ZXIgewogIHBvc2l0aW9uOiBmaXhlZDsKICB0b3A6IHZhcigtLWhlYWRlci1oKTsKICByaWdodDogMDsKICB3aWR0aDogdmFyKC0tZHJhd2VyLXcpOwogIGhlaWdodDogY2FsYygxMDB2aCAtIHZhcigtLWhlYWRlci1oKSk7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZik7CiAgYm9yZGVyLWxlZnQ6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIHRyYW5zZm9ybTogdHJhbnNsYXRlWCgxMDAlKTsKICB0cmFuc2l0aW9uOiB0cmFuc2Zvcm0gLjM1cyBjdWJpYy1iZXppZXIoLjQsMCwuMiwxKTsKICBvdmVyZmxvdy15OiBhdXRvOwogIHotaW5kZXg6IDE1MDsKICBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwp9CgouZHJhd2VyLm9wZW4geyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVgoMCk7IH0KCi5kcmF3ZXItaGVhZGVyIHsKICBwb3NpdGlvbjogc3RpY2t5OyB0b3A6IDA7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZik7CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgcGFkZGluZzogMTZweCAyMHB4OwogIGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsKICB6LWluZGV4OiAxMDsKfQoKLmRyYXdlci10aXRsZSB7CiAgZm9udC1mYW1pbHk6IHZhcigtLXNhbnMpOyBmb250LXdlaWdodDogODAwOyBmb250LXNpemU6IDEzcHg7CiAgbGV0dGVyLXNwYWNpbmc6LjA0ZW07IGNvbG9yOiB2YXIoLS10ZXh0KTsKICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo4cHg7Cn0KCi5kcmF3ZXItc291cmNlIHsKICBmb250LXNpemU6MTBweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBmb250LWZhbWlseTp2YXIoLS1tb25vKTsKfQoKLmJ0bi1jbG9zZSB7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmMik7IGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBjb2xvcjp2YXIoLS1tdXRlZDIpOyBib3JkZXItcmFkaXVzOjZweDsgcGFkZGluZzo1cHggMTBweDsKICBjdXJzb3I6cG9pbnRlcjsgZm9udC1zaXplOjEzcHg7IHRyYW5zaXRpb246IGFsbCAuMTVzOwp9Ci5idG4tY2xvc2U6aG92ZXIgeyBjb2xvcjp2YXIoLS10ZXh0KTsgYm9yZGVyLWNvbG9yOnZhcigtLW11dGVkMik7IH0KCi5kcmF3ZXItYm9keSB7IHBhZGRpbmc6IDE2cHggMjBweDsgZGlzcGxheTogZmxleDsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgZ2FwOiAyMnB4OyB9CgovKiDilIDilIAgRFJBV0VSIFNFQ1RJT05TIOKUgOKUgCAqLwouZC1zZWN0aW9uLWxhYmVsIHsKICBmb250LWZhbWlseTogdmFyKC0tc2Fucyk7IGZvbnQtc2l6ZToxMHB4OyBmb250LXdlaWdodDo3MDA7CiAgbGV0dGVyLXNwYWNpbmc6LjEyZW07IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsKICBjb2xvcjp2YXIoLS1tdXRlZCk7IG1hcmdpbi1ib3R0b206MTBweDsKICBkaXNwbGF5OmZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsgZ2FwOjhweDsKfQouZC1zZWN0aW9uLWxhYmVsOjphZnRlciB7CiAgY29udGVudDonJzsgZmxleDoxOyBoZWlnaHQ6MXB4OyBiYWNrZ3JvdW5kOnZhcigtLWJvcmRlcik7Cn0KCi8qIENhdWNpw7NuIGNhcmRzICovCi5jYXVjaW9uLWdyaWQgeyBkaXNwbGF5OmdyaWQ7IGdyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyIDFmcjsgZ2FwOjhweDsgfQoKLmNhdWNpb24tY2FyZCB7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZjIpOwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czo5cHg7IHBhZGRpbmc6MTJweCAxMHB4OwogIHRleHQtYWxpZ246Y2VudGVyOwogIHRyYW5zaXRpb246IGJvcmRlci1jb2xvciAuMTVzOwp9Ci5jYXVjaW9uLWNhcmQ6aG92ZXIgeyBib3JkZXItY29sb3I6dmFyKC0tYm9yZGVyQik7IH0KCi5jYXVjaW9uLXBsYXpvIHsKICBmb250LXNpemU6MTBweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBsZXR0ZXItc3BhY2luZzouMDhlbTsKICB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7IG1hcmdpbi1ib3R0b206NnB4OyBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6NjAwOwp9CgouY2F1Y2lvbi10bmEgewogIGZvbnQtc2l6ZToyMHB4OyBmb250LXdlaWdodDo3MDA7IGNvbG9yOnZhcigtLXllbGxvdyk7CiAgbGluZS1oZWlnaHQ6MTsKfQouY2F1Y2lvbi11bml0IHsgZm9udC1zaXplOjlweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBtYXJnaW4tdG9wOjNweDsgfQoKLmNhdWNpb24tZGVsdGEgewogIGZvbnQtc2l6ZToxMHB4OyBtYXJnaW4tdG9wOjVweDsKfQouZGVsdGEtdXAgeyBjb2xvcjp2YXIoLS1ncmVlbik7IH0KLmRlbHRhLWRvd24geyBjb2xvcjp2YXIoLS1yZWQpOyB9Ci5kZWx0YS1mbGF0IHsgY29sb3I6dmFyKC0tbXV0ZWQpOyB9CgovKiBCb25vcyB0YWJsZSAqLwouYm9ub3MtdGFibGUgeyB3aWR0aDoxMDAlOyBib3JkZXItY29sbGFwc2U6Y29sbGFwc2U7IH0KCi5ib25vcy10YWJsZSB0aGVhZCB0aCB7CiAgZm9udC1zaXplOjlweDsgbGV0dGVyLXNwYWNpbmc6LjFlbTsgdGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOwogIGNvbG9yOnZhcigtLW11dGVkKTsgcGFkZGluZzo2cHggOHB4OyB0ZXh0LWFsaWduOmxlZnQ7CiAgZm9udC1mYW1pbHk6dmFyKC0tc2Fucyk7IGZvbnQtd2VpZ2h0OjYwMDsKICBib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwp9CgouYm9ub3MtdGFibGUgdGJvZHkgdHIgewogIGJvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgdHJhbnNpdGlvbjogYmFja2dyb3VuZCAuMTJzOwp9Ci5ib25vcy10YWJsZSB0Ym9keSB0cjpob3ZlciB7IGJhY2tncm91bmQ6cmdiYSg0MSwxODIsMjQ2LC4wNCk7IH0KLmJvbm9zLXRhYmxlIHRib2R5IHRyOmxhc3QtY2hpbGQgeyBib3JkZXItYm90dG9tOm5vbmU7IH0KCi5ib25vcy10YWJsZSB0Ym9keSB0ZCB7CiAgcGFkZGluZzoxMHB4IDhweDsgZm9udC1zaXplOjEycHg7Cn0KCi5ib25vLXRpY2tlciB7CiAgZm9udC13ZWlnaHQ6NzAwOyBjb2xvcjp2YXIoLS10ZXh0KTsKICBmb250LXNpemU6MTNweDsKfQouYm9uby1ub21icmUgeyBmb250LXNpemU6OXB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7IG1hcmdpbi10b3A6MnB4OyB9CgoudGlyLXZhbCB7IGNvbG9yOnZhcigtLXllbGxvdyk7IGZvbnQtd2VpZ2h0OjcwMDsgfQoucHJlY2lvLXZhbCB7IGNvbG9yOnZhcigtLW11dGVkMik7IH0KCi52YXItcG9zIHsgY29sb3I6dmFyKC0tZ3JlZW4pOyBmb250LXNpemU6MTFweDsgfQoudmFyLW5lZyB7IGNvbG9yOnZhcigtLXJlZCk7IGZvbnQtc2l6ZToxMXB4OyB9CgovKiBMZXRyYXMgKi8KLmxldHJhcy1saXN0IHsgZGlzcGxheTpmbGV4OyBmbGV4LWRpcmVjdGlvbjpjb2x1bW47IGdhcDo4cHg7IH0KCi5sZXRyYS1yb3cgewogIGJhY2tncm91bmQ6dmFyKC0tc3VyZjIpOwogIGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOjhweDsKICBwYWRkaW5nOjExcHggMTRweDsKICBkaXNwbGF5OmZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsganVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47CiAgdHJhbnNpdGlvbjpib3JkZXItY29sb3IgLjE1czsKfQoubGV0cmEtcm93OmhvdmVyIHsgYm9yZGVyLWNvbG9yOnZhcigtLWJvcmRlckIpOyB9CgoubGV0cmEtbGVmdCB7fQoubGV0cmEtdGlja2VyIHsgZm9udC13ZWlnaHQ6NzAwOyBmb250LXNpemU6MTNweDsgY29sb3I6dmFyKC0tdGV4dCk7IH0KLmxldHJhLXZ0byB7IGZvbnQtc2l6ZToxMHB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7IG1hcmdpbi10b3A6MnB4OyB9CgoubGV0cmEtcmF0ZXMgeyBkaXNwbGF5OmZsZXg7IGdhcDoxNHB4OyB0ZXh0LWFsaWduOnJpZ2h0OyB9Ci5sZXRyYS1yYXRlLWJsb2NrIHt9Ci5sZXRyYS1yYXRlLWxhYmVsIHsgZm9udC1zaXplOjlweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBsZXR0ZXItc3BhY2luZzouMDhlbTsgdGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOyBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6NjAwOyB9Ci5sZXRyYS1yYXRlLXZhbCB7IGZvbnQtc2l6ZToxNXB4OyBmb250LXdlaWdodDo3MDA7IGNvbG9yOnZhcigtLWdyZWVuKTsgbWFyZ2luLXRvcDoxcHg7IH0KCi8qIOKUgOKUgCBDb250ZXh0byBjcnV6YWRvIOKUgOKUgCAqLwouY29udGV4dC1ib3ggewogIGJhY2tncm91bmQ6IHJnYmEoMjU1LDIwNCwwLC4wNik7CiAgYm9yZGVyOiAxcHggc29saWQgcmdiYSgyNTUsMjA0LDAsLjIpOwogIGJvcmRlci1yYWRpdXM6IDlweDsKICBwYWRkaW5nOiAxM3B4IDE1cHg7CiAgZm9udC1zaXplOiAxMXB4OwogIGxpbmUtaGVpZ2h0OjEuNjU7CiAgY29sb3I6dmFyKC0tbXV0ZWQyKTsKfQouY29udGV4dC1ib3ggc3Ryb25nIHsgY29sb3I6dmFyKC0teWVsbG93KTsgfQoKLyogRnVlbnRlIHRhZyAqLwouc291cmNlLXRhZyB7CiAgZGlzcGxheTppbmxpbmUtZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBnYXA6NHB4OwogIGZvbnQtc2l6ZTo5cHg7IGNvbG9yOnZhcigtLW11dGVkKTsKICBiYWNrZ3JvdW5kOnZhcigtLXN1cmYzKTsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yYWRpdXM6NHB4OyBwYWRkaW5nOjJweCA3cHg7Cn0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBTVEFUVVMgQkFOTkVSCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwouc3RhdHVzLWJhbm5lciB7CiAgYm9yZGVyLXJhZGl1czoxMXB4OyBwYWRkaW5nOjE4cHggMjRweDsgbWFyZ2luLWJvdHRvbToyMHB4OwogIGJvcmRlcjoxcHggc29saWQ7IGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOwogIGp1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuOwogIGFuaW1hdGlvbjpmYWRlSW4gLjRzIGVhc2U7CiAgb3ZlcmZsb3c6aGlkZGVuOyBwb3NpdGlvbjpyZWxhdGl2ZTsKfQouc3RhdHVzLWJhbm5lci5zaW1pbGFyIHsKICBiYWNrZ3JvdW5kOnZhcigtLWdyZWVuLWQpOyBib3JkZXItY29sb3I6cmdiYSgwLDIzMCwxMTgsLjI4KTsKfQouc3RhdHVzLWJhbm5lci5zaW1pbGFyOjphZnRlciB7CiAgY29udGVudDonJzsgcG9zaXRpb246YWJzb2x1dGU7IHJpZ2h0Oi01MHB4OyB0b3A6NTAlOwogIHRyYW5zZm9ybTp0cmFuc2xhdGVZKC01MCUpOyB3aWR0aDoyMDBweDsgaGVpZ2h0OjIwMHB4OwogIGJvcmRlci1yYWRpdXM6NTAlOwogIGJhY2tncm91bmQ6cmFkaWFsLWdyYWRpZW50KGNpcmNsZSx2YXIoLS1ncmVlbi1nKSAwJSx0cmFuc3BhcmVudCA3MCUpOwogIHBvaW50ZXItZXZlbnRzOm5vbmU7Cn0KLnN0YXR1cy1iYW5uZXIubm8tc2ltaWxhciB7CiAgYmFja2dyb3VuZDogcmdiYSgyNTUsODIsODIsLjA4KTsKICBib3JkZXItY29sb3I6IHJnYmEoMjU1LDgyLDgyLC4zNSk7Cn0KLnN0YXR1cy1iYW5uZXIubm8tc2ltaWxhcjo6YWZ0ZXIgewogIGNvbnRlbnQ6Jyc7CiAgcG9zaXRpb246YWJzb2x1dGU7CiAgcmlnaHQ6LTUwcHg7CiAgdG9wOjUwJTsKICB0cmFuc2Zvcm06dHJhbnNsYXRlWSgtNTAlKTsKICB3aWR0aDoyMDBweDsKICBoZWlnaHQ6MjAwcHg7CiAgYm9yZGVyLXJhZGl1czo1MCU7CiAgYmFja2dyb3VuZDpyYWRpYWwtZ3JhZGllbnQoY2lyY2xlLHJnYmEoMjU1LDgyLDgyLC4xOCkgMCUsdHJhbnNwYXJlbnQgNzAlKTsKICBwb2ludGVyLWV2ZW50czpub25lOwp9Cgoucy1sZWZ0IHt9Ci5zLXRpdGxlIHsKICBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6ODAwOyBmb250LXNpemU6MjZweDsKICBsZXR0ZXItc3BhY2luZzotLjAyZW07IGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBnYXA6MTJweDsKfQoucy1iYWRnZSB7CiAgZm9udC1zaXplOjEwcHg7IGZvbnQtd2VpZ2h0OjcwMDsgbGV0dGVyLXNwYWNpbmc6LjFlbTsKICB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7IHBhZGRpbmc6MnB4IDlweDsgYm9yZGVyLXJhZGl1czo0cHg7CiAgYmFja2dyb3VuZDp2YXIoLS1ncmVlbik7IGNvbG9yOiMwMDA7IGFsaWduLXNlbGY6Y2VudGVyOwp9Ci5zLWJhZGdlLm5vc2ltIHsgYmFja2dyb3VuZDogdmFyKC0tcmVkKTsgY29sb3I6ICNmZmY7IH0KLnMtc3ViIHsgZm9udC1zaXplOjExcHg7IGNvbG9yOnZhcigtLW11dGVkMik7IG1hcmdpbi10b3A6NHB4OyB9CgouZXJyb3ItYmFubmVyIHsKICBkaXNwbGF5Om5vbmU7CiAgbWFyZ2luOiAwIDAgMTRweCAwOwogIHBhZGRpbmc6IDEwcHggMTJweDsKICBib3JkZXItcmFkaXVzOiA4cHg7CiAgYm9yZGVyOiAxcHggc29saWQgcmdiYSgyNTUsODIsODIsLjQ1KTsKICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSw4Miw4MiwuMTIpOwogIGNvbG9yOiAjZmZkMGQwOwogIGZvbnQtc2l6ZTogMTFweDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsKICBnYXA6IDEwcHg7Cn0KLmVycm9yLWJhbm5lci5zaG93IHsgZGlzcGxheTpmbGV4OyB9Ci5lcnJvci1iYW5uZXIgYnV0dG9uIHsKICBib3JkZXI6MXB4IHNvbGlkIHJnYmEoMjU1LDgyLDgyLC41KTsKICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSw4Miw4MiwuMTUpOwogIGNvbG9yOiNmZmRlZGU7CiAgYm9yZGVyLXJhZGl1czo2cHg7CiAgcGFkZGluZzo0cHggMTBweDsKICBmb250LXNpemU6MTBweDsKICBmb250LXdlaWdodDo3MDA7CiAgdGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOwogIGxldHRlci1zcGFjaW5nOi4wNmVtOwogIGN1cnNvcjpwb2ludGVyOwp9Cgouc2tlbGV0b24gewogIGJhY2tncm91bmQ6IGxpbmVhci1ncmFkaWVudCg5MGRlZywgIzFjMjMzMCAyNSUsICMyYTM0NDQgNTAlLCAjMWMyMzMwIDc1JSk7CiAgYmFja2dyb3VuZC1zaXplOiAyMDAlIDEwMCU7CiAgYW5pbWF0aW9uOiBzaGltbWVyIDEuNHMgaW5maW5pdGU7CiAgYm9yZGVyLXJhZGl1czogNHB4OwogIGNvbG9yOiB0cmFuc3BhcmVudDsKICB1c2VyLXNlbGVjdDogbm9uZTsKfQpAa2V5ZnJhbWVzIHNoaW1tZXIgewogIDAlICAgeyBiYWNrZ3JvdW5kLXBvc2l0aW9uOiAyMDAlIDA7IH0KICAxMDAlIHsgYmFja2dyb3VuZC1wb3NpdGlvbjogLTIwMCUgMDsgfQp9CgoudmFsdWUtY2hhbmdlZCB7CiAgYW5pbWF0aW9uOiBmbGFzaFZhbHVlIDYwMG1zIGVhc2U7Cn0KQGtleWZyYW1lcyBmbGFzaFZhbHVlIHsKICAwJSAgIHsgY29sb3I6ICNmZmNjMDA7IH0KICAxMDAlIHsgY29sb3I6IGluaGVyaXQ7IH0KfQoKLnMtcmlnaHQgeyB0ZXh0LWFsaWduOnJpZ2h0OyBmb250LXNpemU6MTFweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBsaW5lLWhlaWdodDoxLjk7IH0KLnMtcmlnaHQgc3Ryb25nIHsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIEhFUk8gQ0FSRFMK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5oZXJvLWdyaWQgewogIGRpc3BsYXk6Z3JpZDsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnIgMWZyOwogIGdhcDoxNHB4OyBtYXJnaW4tYm90dG9tOjIwcHg7Cn0KCi5oY2FyZCB7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmKTsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yYWRpdXM6MTFweDsgcGFkZGluZzoyMHB4IDIycHg7CiAgcG9zaXRpb246cmVsYXRpdmU7IG92ZXJmbG93OmhpZGRlbjsKICB0cmFuc2l0aW9uOmJvcmRlci1jb2xvciAuMThzOwogIGFuaW1hdGlvbjogZmFkZVVwIC41cyBlYXNlIGJvdGg7Cn0KLmhjYXJkOm50aC1jaGlsZCgxKXthbmltYXRpb24tZGVsYXk6LjA4czt9Ci5oY2FyZDpudGgtY2hpbGQoMil7YW5pbWF0aW9uLWRlbGF5Oi4xNnM7fQouaGNhcmQ6bnRoLWNoaWxkKDMpe2FuaW1hdGlvbi1kZWxheTouMjRzO30KLmhjYXJkOmhvdmVyIHsgYm9yZGVyLWNvbG9yOnZhcigtLWJvcmRlckIpOyB9CgouaGNhcmQgLmJhciB7IHBvc2l0aW9uOmFic29sdXRlOyB0b3A6MDtsZWZ0OjA7cmlnaHQ6MDsgaGVpZ2h0OjJweDsgfQouaGNhcmQubWVwIC5iYXIgeyBiYWNrZ3JvdW5kOnZhcigtLW1lcCk7IH0KLmhjYXJkLmNjbCAuYmFyIHsgYmFja2dyb3VuZDp2YXIoLS1jY2wpOyB9Ci5oY2FyZC5nYXAgLmJhciB7IGJhY2tncm91bmQ6dmFyKC0teWVsbG93KTsgfQoKLmhjYXJkLWxhYmVsIHsKICBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC1zaXplOjEwcHg7IGZvbnQtd2VpZ2h0OjcwMDsKICBsZXR0ZXItc3BhY2luZzouMTJlbTsgdGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOyBjb2xvcjp2YXIoLS1tdXRlZCk7CiAgbWFyZ2luLWJvdHRvbTo5cHg7IGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBnYXA6NXB4Owp9Ci5oY2FyZC1sYWJlbCAuZG90IHsgd2lkdGg6NXB4O2hlaWdodDo1cHg7Ym9yZGVyLXJhZGl1czo1MCU7IH0KLm1lcCAuZG90e2JhY2tncm91bmQ6dmFyKC0tbWVwKTt9Ci5jY2wgLmRvdHtiYWNrZ3JvdW5kOnZhcigtLWNjbCk7fQouZ2FwIC5kb3R7YmFja2dyb3VuZDp2YXIoLS15ZWxsb3cpO30KCi5oY2FyZC12YWwgewogIGZvbnQtc2l6ZTozNHB4OyBmb250LXdlaWdodDo3MDA7IGxldHRlci1zcGFjaW5nOi0uMDJlbTsgbGluZS1oZWlnaHQ6MTsKfQoubWVwIC5oY2FyZC12YWx7Y29sb3I6dmFyKC0tbWVwKTt9Ci5jY2wgLmhjYXJkLXZhbHtjb2xvcjp2YXIoLS1jY2wpO30KCi5oY2FyZC1wY3QgeyBmb250LXNpemU6MjBweDsgY29sb3I6dmFyKC0teWVsbG93KTsgZm9udC13ZWlnaHQ6NzAwOyBtYXJnaW4tdG9wOjNweDsgfQouaGNhcmQtc3ViIHsgZm9udC1zaXplOjEwcHg7IGNvbG9yOnZhcigtLW11dGVkKTsgbWFyZ2luLXRvcDo3cHg7IH0KCi8qIHRvb2x0aXAgKi8KLnRpcCB7IHBvc2l0aW9uOnJlbGF0aXZlOyBjdXJzb3I6aGVscDsgfQoudGlwOjphZnRlciB7CiAgY29udGVudDphdHRyKGRhdGEtdCk7CiAgcG9zaXRpb246YWJzb2x1dGU7IGJvdHRvbTpjYWxjKDEwMCUgKyA3cHgpOyBsZWZ0OjUwJTsKICB0cmFuc2Zvcm06dHJhbnNsYXRlWCgtNTAlKTsKICBiYWNrZ3JvdW5kOiMxYTIyMzI7IGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyQik7CiAgY29sb3I6dmFyKC0tdGV4dCk7IGZvbnQtc2l6ZToxMHB4OyBwYWRkaW5nOjVweCA5cHg7CiAgYm9yZGVyLXJhZGl1czo2cHg7IHdoaXRlLXNwYWNlOm5vd3JhcDsKICBvcGFjaXR5OjA7IHBvaW50ZXItZXZlbnRzOm5vbmU7IHRyYW5zaXRpb246b3BhY2l0eSAuMThzOyB6LWluZGV4Ojk5Owp9Ci50aXA6aG92ZXI6OmFmdGVye29wYWNpdHk6MTt9CgovKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICAgQ0hBUlQK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5jaGFydC1jYXJkIHsKICBiYWNrZ3JvdW5kOnZhcigtLXN1cmYpOyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czoxMXB4OyBwYWRkaW5nOjIycHg7IG1hcmdpbi1ib3R0b206MjBweDsKICBhbmltYXRpb246ZmFkZVVwIC41cyAuMzJzIGVhc2UgYm90aDsKfQouY2hhcnQtdG9wIHsKICBkaXNwbGF5OmZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsganVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47CiAgbWFyZ2luLWJvdHRvbToxNnB4Owp9Ci5jaGFydC10dGwgeyBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC13ZWlnaHQ6NzAwOyBmb250LXNpemU6MTNweDsgfQoKLnBpbGxzIHsgZGlzcGxheTpmbGV4OyBnYXA6NXB4OyB9Ci5waWxsIHsKICBmb250LXNpemU6MTBweDsgcGFkZGluZzozcHggMTFweDsgYm9yZGVyLXJhZGl1czoyMHB4OwogIGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyQik7IGNvbG9yOnZhcigtLW11dGVkMik7CiAgYmFja2dyb3VuZDp0cmFuc3BhcmVudDsgY3Vyc29yOnBvaW50ZXI7IGZvbnQtZmFtaWx5OnZhcigtLW1vbm8pOwogIHRyYW5zaXRpb246YWxsIC4xM3M7Cn0KLnBpbGwub24geyBiYWNrZ3JvdW5kOnZhcigtLW1lcCk7IGJvcmRlci1jb2xvcjp2YXIoLS1tZXApOyBjb2xvcjojMDAwOyBmb250LXdlaWdodDo3MDA7IH0KCi5sZWdlbmRzIHsgZGlzcGxheTpmbGV4OyBnYXA6MThweDsgbWFyZ2luLWJvdHRvbToxNHB4OyBmb250LXNpemU6MTBweDsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgfQoubGVnIHsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGdhcDo1cHg7IH0KLmxlZy1saW5lIHsgd2lkdGg6MThweDsgaGVpZ2h0OjJweDsgYm9yZGVyLXJhZGl1czoycHg7IH0KCnN2Zy5jaGFydCB7IHdpZHRoOjEwMCU7IGhlaWdodDoxNzBweDsgb3ZlcmZsb3c6dmlzaWJsZTsgfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIE1FVFJJQ1MK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCi5tZXRyaWNzLWdyaWQgewogIGRpc3BsYXk6Z3JpZDsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCg0LDFmcik7CiAgZ2FwOjEycHg7IG1hcmdpbi1ib3R0b206MjBweDsKfQoubWNhcmQgewogIGJhY2tncm91bmQ6dmFyKC0tc3VyZjIpOyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czo5cHg7IHBhZGRpbmc6MTRweCAxNnB4OwogIGFuaW1hdGlvbjpmYWRlVXAgLjVzIGVhc2UgYm90aDsKfQoubWNhcmQ6bnRoLWNoaWxkKDEpe2FuaW1hdGlvbi1kZWxheTouMzhzO30KLm1jYXJkOm50aC1jaGlsZCgyKXthbmltYXRpb24tZGVsYXk6LjQzczt9Ci5tY2FyZDpudGgtY2hpbGQoMyl7YW5pbWF0aW9uLWRlbGF5Oi40OHM7fQoubWNhcmQ6bnRoLWNoaWxkKDQpe2FuaW1hdGlvbi1kZWxheTouNTNzO30KLm1jYXJkLWxhYmVsIHsKICBmb250LWZhbWlseTp2YXIoLS1zYW5zKTsgZm9udC1zaXplOjlweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4xZW07IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsgY29sb3I6dmFyKC0tbXV0ZWQpOyBtYXJnaW4tYm90dG9tOjdweDsKfQoubWNhcmQtdmFsIHsgZm9udC1zaXplOjIwcHg7IGZvbnQtd2VpZ2h0OjcwMDsgfQoubWNhcmQtc3ViIHsgZm9udC1zaXplOjlweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBtYXJnaW4tdG9wOjNweDsgfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIFRBQkxFCuKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkCAqLwoudGFibGUtY2FyZCB7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmKTsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yYWRpdXM6MTFweDsgb3ZlcmZsb3c6aGlkZGVuOwogIGFuaW1hdGlvbjpmYWRlVXAgLjVzIC41NnMgZWFzZSBib3RoOwp9Ci50YWJsZS10b3AgewogIHBhZGRpbmc6MTRweCAyMnB4OyBib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjsKfQoudGFibGUtdHRsIHsgZm9udC1mYW1pbHk6dmFyKC0tc2Fucyk7IGZvbnQtd2VpZ2h0OjcwMDsgZm9udC1zaXplOjEzcHg7IH0KLnRhYmxlLWNhcCB7IGZvbnQtc2l6ZToxMHB4OyBjb2xvcjp2YXIoLS1tdXRlZCk7IH0KCnRhYmxlIHsgd2lkdGg6MTAwJTsgYm9yZGVyLWNvbGxhcHNlOmNvbGxhcHNlOyB9CnRoZWFkIHRoIHsKICBmb250LXNpemU6OXB4OyBsZXR0ZXItc3BhY2luZzouMWVtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7CiAgY29sb3I6dmFyKC0tbXV0ZWQpOyBwYWRkaW5nOjlweCAyMnB4OyB0ZXh0LWFsaWduOmxlZnQ7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmMik7IGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXdlaWdodDo2MDA7Cn0KdGJvZHkgdHIgeyBib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOyB0cmFuc2l0aW9uOmJhY2tncm91bmQgLjEyczsgfQp0Ym9keSB0cjpob3ZlciB7IGJhY2tncm91bmQ6cmdiYSg0MSwxODIsMjQ2LC4wNCk7IH0KdGJvZHkgdHI6bGFzdC1jaGlsZCB7IGJvcmRlci1ib3R0b206bm9uZTsgfQp0Ym9keSB0ZCB7IHBhZGRpbmc6MTFweCAyMnB4OyBmb250LXNpemU6MTJweDsgfQp0ZC5kaW0geyBjb2xvcjp2YXIoLS1tdXRlZDIpOyBmb250LXNpemU6MTFweDsgfQoKLnNiYWRnZSB7CiAgZGlzcGxheTppbmxpbmUtYmxvY2s7IGZvbnQtc2l6ZTo5cHg7IGZvbnQtd2VpZ2h0OjcwMDsKICBsZXR0ZXItc3BhY2luZzouMDhlbTsgcGFkZGluZzoycHggN3B4OyBib3JkZXItcmFkaXVzOjRweDsKICB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7Cn0KLnNiYWRnZS5zaW0geyBiYWNrZ3JvdW5kOnZhcigtLWdyZWVuLWQpOyBjb2xvcjp2YXIoLS1ncmVlbik7IGJvcmRlcjoxcHggc29saWQgcmdiYSgwLDIzMCwxMTgsLjIpOyB9Ci5zYmFkZ2Uubm9zaW0geyBiYWNrZ3JvdW5kOnZhcigtLXJlZC1kKTsgY29sb3I6dmFyKC0tcmVkKTsgYm9yZGVyOjFweCBzb2xpZCByZ2JhKDI1NSw3MSw4NywuMik7IH0KCi8qIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogICBGT09URVIgLyBHTE9TQVJJTwrilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAgKi8KLmdsb3NhcmlvIHsKICBtYXJnaW4tdG9wOjIwcHg7IGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOjExcHg7IG92ZXJmbG93OmhpZGRlbjsKICBhbmltYXRpb246ZmFkZVVwIC41cyAuNnMgZWFzZSBib3RoOwp9Ci5nbG9zLWJ0biB7CiAgd2lkdGg6MTAwJTsgYmFja2dyb3VuZDp2YXIoLS1zdXJmKTsgYm9yZGVyOm5vbmU7CiAgY29sb3I6dmFyKC0tbXV0ZWQyKTsgZm9udC1mYW1pbHk6dmFyKC0tbW9ubyk7IGZvbnQtc2l6ZToxMXB4OwogIHBhZGRpbmc6MTNweCAyMnB4OyB0ZXh0LWFsaWduOmxlZnQ7IGN1cnNvcjpwb2ludGVyOwogIGRpc3BsYXk6ZmxleDsgYWxpZ24taXRlbXM6Y2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjsKICB0cmFuc2l0aW9uOmNvbG9yIC4xNXM7Cn0KLmdsb3MtYnRuOmhvdmVyIHsgY29sb3I6dmFyKC0tdGV4dCk7IH0KCi5nbG9zLWdyaWQgewogIGRpc3BsYXk6bm9uZTsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnI7CiAgYmFja2dyb3VuZDp2YXIoLS1zdXJmMik7IGJvcmRlci10b3A6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Cn0KLmdsb3MtZ3JpZC5vcGVuIHsgZGlzcGxheTpncmlkOyB9CgouZ2kgewogIHBhZGRpbmc6MTRweCAyMnB4OyBib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yaWdodDoxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKfQouZ2k6bnRoLWNoaWxkKGV2ZW4pe2JvcmRlci1yaWdodDpub25lO30KLmdpLXRlcm0gewogIGZvbnQtZmFtaWx5OnZhcigtLXNhbnMpOyBmb250LXNpemU6MTBweDsgZm9udC13ZWlnaHQ6NzAwOwogIGxldHRlci1zcGFjaW5nOi4wOGVtOyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7IGNvbG9yOnZhcigtLW11dGVkMik7IG1hcmdpbi1ib3R0b206M3B4Owp9Ci5naS1kZWYgeyBmb250LXNpemU6MTFweDsgY29sb3I6dmFyKC0tbXV0ZWQpOyBsaW5lLWhlaWdodDoxLjU7IH0KCmZvb3RlciB7CiAgdGV4dC1hbGlnbjpjZW50ZXI7IHBhZGRpbmc6MjJweDsgZm9udC1zaXplOjEwcHg7IGNvbG9yOnZhcigtLW11dGVkKTsKICBib3JkZXItdG9wOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwp9CmZvb3RlciBhIHsgY29sb3I6dmFyKC0tbXV0ZWQyKTsgdGV4dC1kZWNvcmF0aW9uOm5vbmU7IH0KZm9vdGVyIGE6aG92ZXIgeyBjb2xvcjp2YXIoLS10ZXh0KTsgfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIEFOSU1BVElPTlMK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCkBrZXlmcmFtZXMgZmFkZUluIHsgZnJvbXtvcGFjaXR5OjA7fXRve29wYWNpdHk6MTt9IH0KQGtleWZyYW1lcyBmYWRlVXAgeyBmcm9te29wYWNpdHk6MDt0cmFuc2Zvcm06dHJhbnNsYXRlWSgxMHB4KTt9dG97b3BhY2l0eToxO3RyYW5zZm9ybTp0cmFuc2xhdGVZKDApO30gfQoKLyog4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQCiAgIFJFU1BPTlNJVkUK4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQ4pWQICovCkBtZWRpYShtYXgtd2lkdGg6OTAwcHgpewogIDpyb290eyAtLWRyYXdlci13OiAxMDB2dzsgfQogIC5ib2R5LXdyYXAuZHJhd2VyLW9wZW4gLm1haW4tY29udGVudCB7IG1hcmdpbi1yaWdodDowOyB9CiAgLmRyYXdlciB7IHdpZHRoOjEwMHZ3OyB9Cn0KQG1lZGlhKG1heC13aWR0aDo3MDBweCl7CiAgLmhlcm8tZ3JpZHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnI7IH0KICAuaGNhcmQuZ2FweyBncmlkLWNvbHVtbjpzcGFuIDI7IH0KICAubWV0cmljcy1ncmlkeyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcjsgfQogIC5oY2FyZC12YWx7IGZvbnQtc2l6ZToyNnB4OyB9CiAgdGhlYWQgdGg6bnRoLWNoaWxkKDQpLCB0Ym9keSB0ZDpudGgtY2hpbGQoNCl7IGRpc3BsYXk6bm9uZTsgfQogIC5zLXJpZ2h0IHsgZGlzcGxheTpub25lOyB9Cn0KQG1lZGlhKG1heC13aWR0aDo0ODBweCl7CiAgLmhlcm8tZ3JpZHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcjsgfQogIC5oY2FyZC5nYXB7IGdyaWQtY29sdW1uOnNwYW4gMTsgfQogIGhlYWRlcnsgcGFkZGluZzowIDE0cHg7IH0KICAudGFnLW1lcmNhZG97IGRpc3BsYXk6bm9uZTsgfQogIC5idG4tdGFzYXMgc3Bhbi5sYWJlbC1sb25nIHsgZGlzcGxheTpub25lOyB9Cn0KCi8qIERSQVdFUiBPVkVSTEFZIChtb2JpbGUpICovCi5vdmVybGF5IHsKICBkaXNwbGF5Om5vbmU7CiAgcG9zaXRpb246Zml4ZWQ7IGluc2V0OjA7IHotaW5kZXg6MTQwOwogIGJhY2tncm91bmQ6cmdiYSgwLDAsMCwuNTUpOwogIGJhY2tkcm9wLWZpbHRlcjpibHVyKDJweCk7Cn0KQG1lZGlhKG1heC13aWR0aDo5MDBweCl7CiAgLm92ZXJsYXkuc2hvdyB7IGRpc3BsYXk6YmxvY2s7IH0KfQo8L3N0eWxlPgo8L2hlYWQ+Cjxib2R5Pgo8ZGl2IGNsYXNzPSJhcHAiPgoKPCEtLSDilIDilIAgSEVBREVSIOKUgOKUgCAtLT4KPGhlYWRlcj4KICA8ZGl2IGNsYXNzPSJsb2dvIj4KICAgIDxzcGFuIGNsYXNzPSJsaXZlLWRvdCI+PC9zcGFuPgogICAgUkFEQVIgTUVQL0NDTAogIDwvZGl2PgogIDxkaXYgY2xhc3M9ImhlYWRlci1yaWdodCI+CiAgICA8ZGl2IGNsYXNzPSJmcmVzaC1iYWRnZSIgaWQ9ImZyZXNoLWJhZGdlIj4KICAgICAgPHNwYW4gY2xhc3M9ImZyZXNoLWRvdCI+PC9zcGFuPgogICAgICA8c3BhbiBpZD0iZnJlc2gtYmFkZ2UtdGV4dCI+QWN0dWFsaXphbmRv4oCmPC9zcGFuPgogICAgPC9kaXY+CiAgICA8c3BhbiBjbGFzcz0idGFnLW1lcmNhZG8iIGlkPSJ0YWctbWVyY2FkbyI+TWVyY2FkbyBhYmllcnRvPC9zcGFuPgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi10YXNhcyIgaWQ9ImJ0blRhc2FzIiBvbmNsaWNrPSJ0b2dnbGVEcmF3ZXIoKSI+CiAgICAgIPCfk4ogPHNwYW4gY2xhc3M9ImxhYmVsLWxvbmciPlRhc2FzICZhbXA7IEJvbm9zPC9zcGFuPgogICAgPC9idXR0b24+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLWFsZXJ0Ij7wn5SUIEFsZXJ0YXM8L2J1dHRvbj4KICA8L2Rpdj4KPC9oZWFkZXI+Cgo8IS0tIOKUgOKUgCBPVkVSTEFZIChtb2JpbGUpIOKUgOKUgCAtLT4KPGRpdiBjbGFzcz0ib3ZlcmxheSIgaWQ9Im92ZXJsYXkiIG9uY2xpY2s9InRvZ2dsZURyYXdlcigpIj48L2Rpdj4KCjwhLS0g4pSA4pSAIEJPRFkgV1JBUCDilIDilIAgLS0+CjxkaXYgY2xhc3M9ImJvZHktd3JhcCIgaWQ9ImJvZHlXcmFwIj4KCiAgPCEtLSDilZDilZDilZDilZAgTUFJTiDilZDilZDilZDilZAgLS0+CiAgPGRpdiBjbGFzcz0ibWFpbi1jb250ZW50Ij4KCiAgICA8IS0tIFNUQVRVUyBCQU5ORVIgLS0+CiAgICA8ZGl2IGNsYXNzPSJzdGF0dXMtYmFubmVyIHNpbWlsYXIiIGlkPSJzdGF0dXMtYmFubmVyIj4KICAgICAgPGRpdiBjbGFzcz0icy1sZWZ0Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJzLXRpdGxlIj4KICAgICAgICAgIDxzcGFuIGlkPSJzdGF0dXMtbGFiZWwiPk1FUCDiiYggQ0NMPC9zcGFuPgogICAgICAgICAgPHNwYW4gY2xhc3M9InMtYmFkZ2UiIGlkPSJzdGF0dXMtYmFkZ2UiPlNpbWlsYXI8L3NwYW4+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icy1zdWIiPkxhIGJyZWNoYSBlc3TDoSBkZW50cm8gZGVsIHVtYnJhbCDigJQgbG9zIHByZWNpb3Mgc29uIGNvbXBhcmFibGVzPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzLXJpZ2h0Ij4KICAgICAgICA8ZGl2PsOabHRpbWEgY29ycmlkYTogPHN0cm9uZyBpZD0ibGFzdC1ydW4tdGltZSI+4oCUPC9zdHJvbmc+PC9kaXY+CiAgICAgICAgPGRpdiBpZD0iY291bnRkb3duLXRleHQiPlByw7N4aW1hIGFjdHVhbGl6YWNpw7NuIGVuIDU6MDA8L2Rpdj4KICAgICAgICA8ZGl2PkNyb24gR01ULTMgwrcgTHVu4oCTVmllIDEwOjMw4oCTMTg6MDA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImVycm9yLWJhbm5lciIgaWQ9ImVycm9yLWJhbm5lciI+CiAgICAgIDxzcGFuIGlkPSJlcnJvci1iYW5uZXItdGV4dCI+RXJyb3IgYWwgYWN0dWFsaXphciDCtyBSZWludGVudGFyPC9zcGFuPgogICAgICA8YnV0dG9uIGlkPSJlcnJvci1yZXRyeS1idG4iIHR5cGU9ImJ1dHRvbiI+UmVpbnRlbnRhcjwvYnV0dG9uPgogICAgPC9kaXY+CgogICAgPCEtLSBIRVJPIENBUkRTIC0tPgogICAgPGRpdiBjbGFzcz0iaGVyby1ncmlkIj4KICAgICAgPGRpdiBjbGFzcz0iaGNhcmQgbWVwIj4KICAgICAgICA8ZGl2IGNsYXNzPSJiYXIiPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLWxhYmVsIj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJkb3QiPjwvc3Bhbj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0aXAiIGRhdGEtdD0iRMOzbGFyIEJvbHNhIOKAlCBjb21wcmEvdmVudGEgZGUgYm9ub3MgZW4gJEFSUyB5IFVTRCI+TUVQIHZlbnRhIOKTmDwvc3Bhbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC12YWwiIGlkPSJtZXAtdmFsIj4kMS4yNjQ8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC1zdWIiPmRvbGFyaXRvLmFyIMK3IHZlbnRhPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoY2FyZCBjY2wiPgogICAgICAgIDxkaXYgY2xhc3M9ImJhciI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtbGFiZWwiPgogICAgICAgICAgPHNwYW4gY2xhc3M9ImRvdCI+PC9zcGFuPgogICAgICAgICAgPHNwYW4gY2xhc3M9InRpcCIgZGF0YS10PSJDb250YWRvIGNvbiBMaXF1aWRhY2nDs24g4oCUIHNpbWlsYXIgYWwgTUVQIGNvbiBnaXJvIGFsIGV4dGVyaW9yIj5DQ0wgdmVudGEg4pOYPC9zcGFuPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLXZhbCIgaWQ9ImNjbC12YWwiPiQxLjI3MTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLXN1YiI+ZG9sYXJpdG8uYXIgwrcgdmVudGE8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImhjYXJkIGdhcCI+CiAgICAgICAgPGRpdiBjbGFzcz0iYmFyIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC1sYWJlbCI+CiAgICAgICAgICA8c3BhbiBjbGFzcz0iZG90Ij48L3NwYW4+CiAgICAgICAgICA8c3BhbiBjbGFzcz0idGlwIiBkYXRhLXQ9IkJyZWNoYSByZWxhdGl2YSBjb250cmEgZWwgcHJvbWVkaW8gZW50cmUgTUVQIHkgQ0NMIj5CcmVjaGEg4pOYPC9zcGFuPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhjYXJkLXZhbCIgaWQ9ImJyZWNoYS1hYnMiPiQ3PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGNhcmQtcGN0IiBpZD0iYnJlY2hhLXBjdCI+MC41NSU8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoY2FyZC1zdWIiPmRpZmVyZW5jaWEgYWJzb2x1dGEgwrcgcG9yY2VudHVhbDwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAgIDwhLS0gQ0hBUlQgLS0+CiAgICA8ZGl2IGNsYXNzPSJjaGFydC1jYXJkIj4KICAgICAgPGRpdiBjbGFzcz0iY2hhcnQtdG9wIj4KICAgICAgICA8ZGl2IGNsYXNzPSJjaGFydC10dGwiPlRlbmRlbmNpYSBkZSBicmVjaGEg4oCUIMO6bHRpbWFzIDI0aDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InBpbGxzIj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9InBpbGwiPjIwIHB0czwvYnV0dG9uPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0icGlsbCBvbiI+NDAgcHRzPC9idXR0b24+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJwaWxsIj5Ub2RvPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJsZWdlbmRzIj4KICAgICAgICA8ZGl2IGNsYXNzPSJsZWciPjxkaXYgY2xhc3M9ImxlZy1saW5lIiBzdHlsZT0iYmFja2dyb3VuZDp2YXIoLS1tZXApIj48L2Rpdj5NRVA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJsZWciPjxkaXYgY2xhc3M9ImxlZy1saW5lIiBzdHlsZT0iYmFja2dyb3VuZDp2YXIoLS1jY2wpIj48L2Rpdj5DQ0w8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJsZWciPjxkaXYgY2xhc3M9ImxlZy1saW5lIiBzdHlsZT0iYmFja2dyb3VuZDp2YXIoLS15ZWxsb3cpO29wYWNpdHk6LjciPjwvZGl2PkJyZWNoYSAlPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibGVnIj48ZGl2IGNsYXNzPSJsZWctbGluZSIgc3R5bGU9ImJhY2tncm91bmQ6dmFyKC0tZ3JlZW4pO29wYWNpdHk6LjQiPjwvZGl2PlVtYnJhbCAxJTwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPHN2ZyBjbGFzcz0iY2hhcnQiIGlkPSJ0cmVuZC1jaGFydCIgdmlld0JveD0iMCAwIDg2MCAxNjAiIHByZXNlcnZlQXNwZWN0UmF0aW89Im5vbmUiPgogICAgICAgIDxsaW5lIHgxPSIwIiB5MT0iNDAiIHgyPSI4NjAiIHkyPSI0MCIgc3Ryb2tlPSIjMWUyNTMwIiBzdHJva2Utd2lkdGg9IjEiLz4KICAgICAgICA8bGluZSB4MT0iMCIgeTE9IjgwIiB4Mj0iODYwIiB5Mj0iODAiIHN0cm9rZT0iIzFlMjUzMCIgc3Ryb2tlLXdpZHRoPSIxIi8+CiAgICAgICAgPGxpbmUgeDE9IjAiIHkxPSIxMjAiIHgyPSI4NjAiIHkyPSIxMjAiIHN0cm9rZT0iIzFlMjUzMCIgc3Ryb2tlLXdpZHRoPSIxIi8+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXktdG9wIiB4PSIyIiB5PSIzNyIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI4IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC15LW1pZCIgeD0iMiIgeT0iNzciIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iOCIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteS1sb3ciIHg9IjIiIHk9IjExNyIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI4IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgIDxwb2x5bGluZSBpZD0idHJlbmQtbWVwLWxpbmUiIHBvaW50cz0iIiBmaWxsPSJub25lIiBzdHJva2U9IiMyOWI2ZjYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgogICAgICAgIDxwb2x5bGluZSBpZD0idHJlbmQtY2NsLWxpbmUiIHBvaW50cz0iIiBmaWxsPSJub25lIiBzdHJva2U9IiNiMzlkZGIiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgogICAgICAgIDxwb2x5bGluZSBpZD0idHJlbmQtZ2FwLWxpbmUiIHBvaW50cz0iIiBmaWxsPSJub25lIiBzdHJva2U9IiNmZmNjMDAiIHN0cm9rZS13aWR0aD0iMS41IiBzdHJva2UtZGFzaGFycmF5PSI0LDQiIG9wYWNpdHk9Ii43NSIvPgogICAgICAgIDxsaW5lIGlkPSJ0cmVuZC10aHJlc2hvbGQiIHgxPSIzMCIgeTE9IjYyIiB4Mj0iODQwIiB5Mj0iNjIiIHN0cm9rZT0iIzAwZTY3NiIgc3Ryb2tlLXdpZHRoPSIxIiBzdHJva2UtZGFzaGFycmF5PSIzLDkiIG9wYWNpdHk9Ii4yOCIvPgogICAgICAgIDx0ZXh0IHg9Ijg0MyIgeT0iNjUiIGZpbGw9IiMwMGU2NzYiIGZvbnQtc2l6ZT0iNyIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iIG9wYWNpdHk9Ii42Ij4xJTwvdGV4dD4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteC0xIiB4PSIyOCIgeT0iMTU0IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjciIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXgtMiIgeD0iMjE4IiB5PSIxNTQiIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iNyIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgICA8dGV4dCBpZD0idHJlbmQteC0zIiB4PSI0MTgiIHk9IjE1NCIgZmlsbD0iIzQ3NTU2OSIgZm9udC1zaXplPSI3IiBmb250LWZhbWlseT0iU3BhY2UgTW9ubyI+4oCUPC90ZXh0PgogICAgICAgIDx0ZXh0IGlkPSJ0cmVuZC14LTQiIHg9IjYwOCIgeT0iMTU0IiBmaWxsPSIjNDc1NTY5IiBmb250LXNpemU9IjciIGZvbnQtZmFtaWx5PSJTcGFjZSBNb25vIj7igJQ8L3RleHQ+CiAgICAgICAgPHRleHQgaWQ9InRyZW5kLXgtNSIgeD0iNzk4IiB5PSIxNTQiIGZpbGw9IiM0NzU1NjkiIGZvbnQtc2l6ZT0iNyIgZm9udC1mYW1pbHk9IlNwYWNlIE1vbm8iPuKAlDwvdGV4dD4KICAgICAgPC9zdmc+CiAgICA8L2Rpdj4KCiAgICA8IS0tIE1FVFJJQ1MgLS0+CiAgICA8ZGl2IGNsYXNzPSJtZXRyaWNzLWdyaWQiPgogICAgICA8ZGl2IGNsYXNzPSJtY2FyZCI+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtbGFiZWwiPk11ZXN0cmFzIDI0aDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXZhbCIgaWQ9Im1ldHJpYy1jb3VudC0yNGgiPuKAlDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXN1YiI+cmVnaXN0cm9zIGRlbCBwZXLDrW9kbzwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ibWNhcmQiPgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLWxhYmVsIj5WZWNlcyBzaW1pbGFyPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtdmFsIiBzdHlsZT0iY29sb3I6dmFyKC0tZ3JlZW4pIiBpZD0ibWV0cmljLXNpbWlsYXItMjRoIj7igJQ8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1zdWIiPm1vbWVudG9zIGVuIHpvbmEg4omkMSU8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Im1jYXJkIj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC1sYWJlbCI+QnJlY2hhIG3DrW4uPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWNhcmQtdmFsIiBpZD0ibWV0cmljLW1pbi0yNGgiPuKAlDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXN1YiI+bcOtbmltYSByZWdpc3RyYWRhIGhveTwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ibWNhcmQiPgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLWxhYmVsIj5CcmVjaGEgbcOheC48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtY2FyZC12YWwiIHN0eWxlPSJjb2xvcjp2YXIoLS15ZWxsb3cpIiBpZD0ibWV0cmljLW1heC0yNGgiPuKAlDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1jYXJkLXN1YiI+bcOheGltYSByZWdpc3RyYWRhIGhveTwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAgIDwhLS0gVEFCTEUgLS0+CiAgICA8ZGl2IGNsYXNzPSJ0YWJsZS1jYXJkIj4KICAgICAgPGRpdiBjbGFzcz0idGFibGUtdG9wIj4KICAgICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS10dGwiPkhpc3RvcmlhbCBkZSByZWdpc3Ryb3M8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS1jYXAiIGlkPSJoaXN0b3J5LWNhcCI+w5psdGltYXMg4oCUIG11ZXN0cmFzPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8dGFibGU+CiAgICAgICAgPHRoZWFkPgogICAgICAgICAgPHRyPgogICAgICAgICAgICA8dGg+SG9yYTwvdGg+CiAgICAgICAgICAgIDx0aD5NRVA8L3RoPgogICAgICAgICAgICA8dGg+Q0NMPC90aD4KICAgICAgICAgICAgPHRoPkRpZiAkPC90aD4KICAgICAgICAgICAgPHRoPkRpZiAlPC90aD4KICAgICAgICAgICAgPHRoPkVzdGFkbzwvdGg+CiAgICAgICAgICA8L3RyPgogICAgICAgIDwvdGhlYWQ+CiAgICAgICAgPHRib2R5IGlkPSJoaXN0b3J5LXJvd3MiPjwvdGJvZHk+CiAgICAgIDwvdGFibGU+CiAgICA8L2Rpdj4KCiAgICA8IS0tIEdMT1NBUklPIC0tPgogICAgPGRpdiBjbGFzcz0iZ2xvc2FyaW8iPgogICAgICA8YnV0dG9uIGNsYXNzPSJnbG9zLWJ0biIgb25jbGljaz0idG9nZ2xlR2xvcyh0aGlzKSI+CiAgICAgICAgPHNwYW4+8J+TliBHbG9zYXJpbyBkZSB0w6lybWlub3M8L3NwYW4+CiAgICAgICAgPHNwYW4gaWQ9Imdsb3NBcnJvdyI+4pa+PC9zcGFuPgogICAgICA8L2J1dHRvbj4KICAgICAgPGRpdiBjbGFzcz0iZ2xvcy1ncmlkIiBpZD0iZ2xvc0dyaWQiPgogICAgICAgIDxkaXYgY2xhc3M9ImdpIj48ZGl2IGNsYXNzPSJnaS10ZXJtIj5NRVAgdmVudGE8L2Rpdj48ZGl2IGNsYXNzPSJnaS1kZWYiPlByZWNpbyBkZSB2ZW50YSBkZWwgZMOzbGFyIE1FUCAoTWVyY2FkbyBFbGVjdHLDs25pY28gZGUgUGFnb3MpIHbDrWEgY29tcHJhL3ZlbnRhIGRlIGJvbm9zIGVuICRBUlMgeSBVU0QuPC9kaXY+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZ2kiPjxkaXYgY2xhc3M9ImdpLXRlcm0iPkNDTCB2ZW50YTwvZGl2PjxkaXYgY2xhc3M9ImdpLWRlZiI+Q29udGFkbyBjb24gTGlxdWlkYWNpw7NuIOKAlCBzaW1pbGFyIGFsIE1FUCBwZXJvIHBlcm1pdGUgdHJhbnNmZXJpciBmb25kb3MgYWwgZXh0ZXJpb3IuIFN1ZWxlIGNvdGl6YXIgbGV2ZW1lbnRlIHBvciBlbmNpbWEuPC9kaXY+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZ2kiPjxkaXYgY2xhc3M9ImdpLXRlcm0iPkRpZmVyZW5jaWEgJTwvZGl2PjxkaXYgY2xhc3M9ImdpLWRlZiI+QnJlY2hhIHJlbGF0aXZhIGNhbGN1bGFkYSBjb250cmEgZWwgcHJvbWVkaW8gZW50cmUgTUVQIHkgQ0NMLiBVbWJyYWwgU0lNSUxBUjog4omkIDElIG8g4omkICQxMCBBUlMuPC9kaXY+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZ2kiPjxkaXYgY2xhc3M9ImdpLXRlcm0iPkZyZXNjdXJhIGRlbCBkYXRvPC9kaXY+PGRpdiBjbGFzcz0iZ2ktZGVmIj5UaWVtcG8gZGVzZGUgZWwgw7psdGltbyB0aW1lc3RhbXAgZGUgZG9sYXJpdG8uYXIuIEVsIGNyb24gY29ycmUgY2FkYSA1IG1pbiBlbiBkw61hcyBow6FiaWxlcy48L2Rpdj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJnaSI+PGRpdiBjbGFzcz0iZ2ktdGVybSI+RXN0YWRvIFNJTUlMQVI8L2Rpdj48ZGl2IGNsYXNzPSJnaS1kZWYiPkN1YW5kbyBNRVAgeSBDQ0wgZXN0w6FuIGRlbnRybyBkZWwgdW1icmFsIOKAlCBtb21lbnRvIGlkZWFsIHBhcmEgb3BlcmFyIGJ1c2NhbmRvIHBhcmlkYWQgZW50cmUgYW1ib3MgdGlwb3MuPC9kaXY+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZ2kiPjxkaXYgY2xhc3M9ImdpLXRlcm0iPk1lcmNhZG8gQVJHPC9kaXY+PGRpdiBjbGFzcz0iZ2ktZGVmIj5WZW50YW5hIG9wZXJhdGl2YTogbHVuZXMgYSB2aWVybmVzIGRlIDEwOjMwIGEgMTc6NTkgKEdNVC0zLCBCdWVub3MgQWlyZXMpLjwvZGl2PjwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAgIDxmb290ZXI+CiAgICAgIEZ1ZW50ZTogPGEgaHJlZj0iIyI+ZG9sYXJpdG8uYXI8L2E+IMK3IDxhIGhyZWY9IiMiPmJ5bWEuY29tLmFyPC9hPiDCtyBEYXRvcyBjYWRhIDUgbWluIGVuIGTDrWFzIGjDoWJpbGVzIMK3IDxhIGhyZWY9IiMiPlJlcG9ydGFyIHByb2JsZW1hPC9hPgogICAgPC9mb290ZXI+CgogIDwvZGl2PjwhLS0gL21haW4tY29udGVudCAtLT4KCiAgPCEtLSDilZDilZDilZDilZAgRFJBV0VSIOKVkOKVkOKVkOKVkCAtLT4KICA8ZGl2IGNsYXNzPSJkcmF3ZXIiIGlkPSJkcmF3ZXIiPgoKICAgIDxkaXYgY2xhc3M9ImRyYXdlci1oZWFkZXIiPgogICAgICA8ZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImRyYXdlci10aXRsZSI+8J+TiiBUYXNhcyAmYW1wOyBCb25vczwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImRyYXdlci1zb3VyY2UiPkZ1ZW50ZXM6IGRvbGFyaXRvLmFyIMK3IGJ5bWEuY29tLmFyPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4tY2xvc2UiIG9uY2xpY2s9InRvZ2dsZURyYXdlcigpIj7inJU8L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImRyYXdlci1ib2R5Ij4KCiAgICAgIDwhLS0g4pSA4pSAIENBVUNJw5NOIOKUgOKUgCAtLT4KICAgICAgPGRpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJkLXNlY3Rpb24tbGFiZWwiPkNhdWNpw7NuIGJ1cnPDoXRpbCAmbmJzcDs8c3BhbiBjbGFzcz0ic291cmNlLXRhZyI+ZG9sYXJpdG8uYXI8L3NwYW4+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iY2F1Y2lvbi1ncmlkIj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImNhdWNpb24tY2FyZCI+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImNhdWNpb24tcGxhem8iPjEgZMOtYTwvZGl2PgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJjYXVjaW9uLXRuYSIgaWQ9ImNhdWNpb24tMWQtdG5hIj41OC4yJTwvZGl2PgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJjYXVjaW9uLXVuaXQiPlROQTwvZGl2PgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJjYXVjaW9uLWRlbHRhIGRlbHRhLXVwIiBpZD0iY2F1Y2lvbi0xZC1kZWx0YSI+4payICsxLjRwcDwvZGl2PgogICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJjYXVjaW9uLWNhcmQiPgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJjYXVjaW9uLXBsYXpvIj43IGTDrWFzPC9kaXY+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImNhdWNpb24tdG5hIiBpZD0iY2F1Y2lvbi03ZC10bmEiPjYxLjUlPC9kaXY+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImNhdWNpb24tdW5pdCI+VE5BPC9kaXY+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImNhdWNpb24tZGVsdGEgZGVsdGEtZmxhdCIgaWQ9ImNhdWNpb24tN2QtZGVsdGEiPuKAlCBzaW4gY2FtYmlvPC9kaXY+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImNhdWNpb24tY2FyZCI+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImNhdWNpb24tcGxhem8iPjMwIGTDrWFzPC9kaXY+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImNhdWNpb24tdG5hIiBpZD0iY2F1Y2lvbi0zMGQtdG5hIj42NC44JTwvZGl2PgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJjYXVjaW9uLXVuaXQiPlROQTwvZGl2PgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJjYXVjaW9uLWRlbHRhIGRlbHRhLWRvd24iIGlkPSJjYXVjaW9uLTMwZC1kZWx0YSI+4pa8IOKIkjAuOHBwPC9kaXY+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IHN0eWxlPSJtYXJnaW4tdG9wOjhweDsgZm9udC1zaXplOjEwcHg7IGNvbG9yOnZhcigtLW11dGVkKSI+CiAgICAgICAgICBURUEgMzBkIGVzdGltYWRhOiA8c3Ryb25nIGlkPSJjYXVjaW9uLXRlYS0zMGQiIHN0eWxlPSJjb2xvcjp2YXIoLS1tdXRlZDIpIj44OC4zJTwvc3Ryb25nPiAmbmJzcDvCtyZuYnNwOyBQYXNhIHNwcmVhZDogPHN0cm9uZyBzdHlsZT0iY29sb3I6dmFyKC0tbXV0ZWQyKSI+KzYuNnBwIHZzIDFkPC9zdHJvbmc+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPCEtLSDilIDilIAgQk9OT1MgU09CRVJBTk9TIOKUgOKUgCAtLT4KICAgICAgPGRpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJkLXNlY3Rpb24tbGFiZWwiPkJvbm9zIHNvYmVyYW5vcyBjbGF2ZSAmbmJzcDs8c3BhbiBjbGFzcz0ic291cmNlLXRhZyI+YnltYS5jb20uYXI8L3NwYW4+PC9kaXY+CiAgICAgICAgPHRhYmxlIGNsYXNzPSJib25vcy10YWJsZSI+CiAgICAgICAgICA8dGhlYWQ+CiAgICAgICAgICAgIDx0cj4KICAgICAgICAgICAgICA8dGg+Qm9ubzwvdGg+CiAgICAgICAgICAgICAgPHRoPlRJUjwvdGg+CiAgICAgICAgICAgICAgPHRoPlByZWNpbzwvdGg+CiAgICAgICAgICAgICAgPHRoPlZhci4gZMOtYTwvdGg+CiAgICAgICAgICAgIDwvdHI+CiAgICAgICAgICA8L3RoZWFkPgogICAgICAgICAgPHRib2R5PgogICAgICAgICAgICA8dHI+CiAgICAgICAgICAgICAgPHRkPgogICAgICAgICAgICAgICAgPGRpdiBjbGFzcz0iYm9uby10aWNrZXIiPkFMMzA8L2Rpdj4KICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImJvbm8tbm9tYnJlIj5Cb25vIEFyZy4gMjAzMCAkPC9kaXY+CiAgICAgICAgICAgICAgPC90ZD4KICAgICAgICAgICAgICA8dGQ+PHNwYW4gY2xhc3M9InRpci12YWwiIGlkPSJib25vLUFMMzAtdGlyIj4xMS40JTwvc3Bhbj48L3RkPgogICAgICAgICAgICAgIDx0ZD48c3BhbiBjbGFzcz0icHJlY2lvLXZhbCIgaWQ9ImJvbm8tQUwzMC1wcmVjaW8iPjY3LjIwPC9zcGFuPjwvdGQ+CiAgICAgICAgICAgICAgPHRkPjxzcGFuIGNsYXNzPSJ2YXItcG9zIiBpZD0iYm9uby1BTDMwLXZhciI+KzEuOCU8L3NwYW4+PC90ZD4KICAgICAgICAgICAgPC90cj4KICAgICAgICAgICAgPHRyPgogICAgICAgICAgICAgIDx0ZD4KICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImJvbm8tdGlja2VyIj5HRDMwPC9kaXY+CiAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJib25vLW5vbWJyZSI+Qm9ubyBBcmcuIDIwMzAgVVNEPC9kaXY+CiAgICAgICAgICAgICAgPC90ZD4KICAgICAgICAgICAgICA8dGQ+PHNwYW4gY2xhc3M9InRpci12YWwiIGlkPSJib25vLUdEMzAtdGlyIj4xMC45JTwvc3Bhbj48L3RkPgogICAgICAgICAgICAgIDx0ZD48c3BhbiBjbGFzcz0icHJlY2lvLXZhbCIgaWQ9ImJvbm8tR0QzMC1wcmVjaW8iPjY5LjUwPC9zcGFuPjwvdGQ+CiAgICAgICAgICAgICAgPHRkPjxzcGFuIGNsYXNzPSJ2YXItcG9zIiBpZD0iYm9uby1HRDMwLXZhciI+KzAuOSU8L3NwYW4+PC90ZD4KICAgICAgICAgICAgPC90cj4KICAgICAgICAgICAgPHRyPgogICAgICAgICAgICAgIDx0ZD4KICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImJvbm8tdGlja2VyIj5BTDM1PC9kaXY+CiAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJib25vLW5vbWJyZSI+Qm9ubyBBcmcuIDIwMzUgJDwvZGl2PgogICAgICAgICAgICAgIDwvdGQ+CiAgICAgICAgICAgICAgPHRkPjxzcGFuIGNsYXNzPSJ0aXItdmFsIiBpZD0iYm9uby1BTDM1LXRpciI+MTIuMSU8L3NwYW4+PC90ZD4KICAgICAgICAgICAgICA8dGQ+PHNwYW4gY2xhc3M9InByZWNpby12YWwiIGlkPSJib25vLUFMMzUtcHJlY2lvIj41Ni44MDwvc3Bhbj48L3RkPgogICAgICAgICAgICAgIDx0ZD48c3BhbiBjbGFzcz0idmFyLW5lZyIgaWQ9ImJvbm8tQUwzNS12YXIiPuKIkjAuNCU8L3NwYW4+PC90ZD4KICAgICAgICAgICAgPC90cj4KICAgICAgICAgICAgPHRyPgogICAgICAgICAgICAgIDx0ZD4KICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImJvbm8tdGlja2VyIj5HRDM1PC9kaXY+CiAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJib25vLW5vbWJyZSI+Qm9ubyBBcmcuIDIwMzUgVVNEPC9kaXY+CiAgICAgICAgICAgICAgPC90ZD4KICAgICAgICAgICAgICA8dGQ+PHNwYW4gY2xhc3M9InRpci12YWwiIGlkPSJib25vLUdEMzUtdGlyIj4xMS44JTwvc3Bhbj48L3RkPgogICAgICAgICAgICAgIDx0ZD48c3BhbiBjbGFzcz0icHJlY2lvLXZhbCIgaWQ9ImJvbm8tR0QzNS1wcmVjaW8iPjU4LjEwPC9zcGFuPjwvdGQ+CiAgICAgICAgICAgICAgPHRkPjxzcGFuIGNsYXNzPSJ2YXItcG9zIiBpZD0iYm9uby1HRDM1LXZhciI+KzAuMyU8L3NwYW4+PC90ZD4KICAgICAgICAgICAgPC90cj4KICAgICAgICAgICAgPHRyPgogICAgICAgICAgICAgIDx0ZD4KICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImJvbm8tdGlja2VyIj5HRDQxPC9kaXY+CiAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJib25vLW5vbWJyZSI+Qm9ubyBBcmcuIDIwNDEgVVNEPC9kaXY+CiAgICAgICAgICAgICAgPC90ZD4KICAgICAgICAgICAgICA8dGQ+PHNwYW4gY2xhc3M9InRpci12YWwiIGlkPSJib25vLUdENDEtdGlyIj4xMi42JTwvc3Bhbj48L3RkPgogICAgICAgICAgICAgIDx0ZD48c3BhbiBjbGFzcz0icHJlY2lvLXZhbCIgaWQ9ImJvbm8tR0Q0MS1wcmVjaW8iPjUyLjQwPC9zcGFuPjwvdGQ+CiAgICAgICAgICAgICAgPHRkPjxzcGFuIGNsYXNzPSJ2YXItbmVnIiBpZD0iYm9uby1HRDQxLXZhciI+4oiSMC43JTwvc3Bhbj48L3RkPgogICAgICAgICAgICA8L3RyPgogICAgICAgICAgPC90Ym9keT4KICAgICAgICA8L3RhYmxlPgogICAgICA8L2Rpdj4KCiAgICAgIDwhLS0g4pSA4pSAIExFVFJBUyBERUwgVEVTT1JPIOKUgOKUgCAtLT4KICAgICAgPGRpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJkLXNlY3Rpb24tbGFiZWwiPkxldHJhcyBkZWwgVGVzb3JvICZuYnNwOzxzcGFuIGNsYXNzPSJzb3VyY2UtdGFnIj5ieW1hLmNvbS5hcjwvc3Bhbj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYXMtbGlzdCI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS1yb3ciPgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS1sZWZ0Ij4KICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS10aWNrZXIiPkxFREUgRmViLTI1PC9kaXY+CiAgICAgICAgICAgICAgPGRpdiBjbGFzcz0ibGV0cmEtdnRvIiBpZD0ibGV0cmEtTEVERS1GRUIyNS12dG8iPlZ0bzogMjgvMDIvMjAyNSDCtyBEZXNjdWVudG88L2Rpdj4KICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImxldHJhLXJhdGVzIj4KICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS1yYXRlLWJsb2NrIj4KICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImxldHJhLXJhdGUtbGFiZWwiPlROQTwvZGl2PgogICAgICAgICAgICAgICAgPGRpdiBjbGFzcz0ibGV0cmEtcmF0ZS12YWwiIGlkPSJsZXRyYS1MRURFLUZFQjI1LXRuYSI+NTcuOCU8L2Rpdj4KICAgICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS1yYXRlLWJsb2NrIj4KICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImxldHJhLXJhdGUtbGFiZWwiPlRFQTwvZGl2PgogICAgICAgICAgICAgICAgPGRpdiBjbGFzcz0ibGV0cmEtcmF0ZS12YWwiIGlkPSJsZXRyYS1MRURFLUZFQjI1LXRlYSIgc3R5bGU9ImNvbG9yOnZhcigtLW11dGVkMikiPjc2LjMlPC9kaXY+CiAgICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS1yb3ciPgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS1sZWZ0Ij4KICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS10aWNrZXIiPkxFQ0FQIE1hci0yNTwvZGl2PgogICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImxldHJhLXZ0byIgaWQ9ImxldHJhLUxFQ0FQLU1BUjI1LXZ0byI+VnRvOiAzMS8wMy8yMDI1IMK3IENhcGl0YWxpemFibGU8L2Rpdj4KICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImxldHJhLXJhdGVzIj4KICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS1yYXRlLWJsb2NrIj4KICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImxldHJhLXJhdGUtbGFiZWwiPlRFTTwvZGl2PgogICAgICAgICAgICAgICAgPGRpdiBjbGFzcz0ibGV0cmEtcmF0ZS12YWwiIGlkPSJsZXRyYS1MRUNBUC1NQVIyNS10bmEiPjQuNiU8L2Rpdj4KICAgICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS1yYXRlLWJsb2NrIj4KICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImxldHJhLXJhdGUtbGFiZWwiPlRFQTwvZGl2PgogICAgICAgICAgICAgICAgPGRpdiBjbGFzcz0ibGV0cmEtcmF0ZS12YWwiIGlkPSJsZXRyYS1MRUNBUC1NQVIyNS10ZWEiIHN0eWxlPSJjb2xvcjp2YXIoLS1tdXRlZDIpIj43Mi4xJTwvZGl2PgogICAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0ibGV0cmEtcm93Ij4KICAgICAgICAgICAgPGRpdiBjbGFzcz0ibGV0cmEtbGVmdCI+CiAgICAgICAgICAgICAgPGRpdiBjbGFzcz0ibGV0cmEtdGlja2VyIj5MRUNBUCBNYXktMjU8L2Rpdj4KICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS12dG8iIGlkPSJsZXRyYS1MRUNBUC1NQVkyNS12dG8iPlZ0bzogMzAvMDUvMjAyNSDCtyBDYXBpdGFsaXphYmxlPC9kaXY+CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS1yYXRlcyI+CiAgICAgICAgICAgICAgPGRpdiBjbGFzcz0ibGV0cmEtcmF0ZS1ibG9jayI+CiAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS1yYXRlLWxhYmVsIj5URU08L2Rpdj4KICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImxldHJhLXJhdGUtdmFsIiBpZD0ibGV0cmEtTEVDQVAtTUFZMjUtdG5hIj40LjklPC9kaXY+CiAgICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgICAgPGRpdiBjbGFzcz0ibGV0cmEtcmF0ZS1ibG9jayI+CiAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJsZXRyYS1yYXRlLWxhYmVsIj5URUE8L2Rpdj4KICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9ImxldHJhLXJhdGUtdmFsIiBpZD0ibGV0cmEtTEVDQVAtTUFZMjUtdGVhIiBzdHlsZT0iY29sb3I6dmFyKC0tbXV0ZWQyKSI+NzguOCU8L2Rpdj4KICAgICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CgogICAgICA8IS0tIOKUgOKUgCBDT05URVhUTyBDUlVaQURPIOKUgOKUgCAtLT4KICAgICAgPGRpdiBjbGFzcz0iY29udGV4dC1ib3giIGlkPSJjb250ZXh0LWJveCI+CiAgICAgICAg8J+SoSA8c3Ryb25nPkNvbnRleHRvOjwvc3Ryb25nPiBDb24gdW5hIGNhdWNpw7NuIGEgMSBkw61hIGFsIDxzdHJvbmc+NTguMiUgVE5BPC9zdHJvbmc+IHkgZWwgQUwzMCByaW5kaWVuZG8gPHN0cm9uZz4xMS40JSBUSVI8L3N0cm9uZz4gZW4gZMOzbGFyZXMsIGxhIGJyZWNoYSBNRVAvQ0NMIGFjdHVhbCBkZSA8c3Ryb25nPjAuNTUlPC9zdHJvbmc+IHN1Z2llcmUgcGFyaWRhZCBvcGVyYXRpdmEuIE1vbWVudG8gZmF2b3JhYmxlIHBhcmEgYXJiaXRyYXIgZW50cmUgaW5zdHJ1bWVudG9zIHNpIHR1IGhvcml6b250ZSBlcyBjb3J0by4KICAgICAgPC9kaXY+CgogICAgPC9kaXY+PCEtLSAvZHJhd2VyLWJvZHkgLS0+CiAgPC9kaXY+PCEtLSAvZHJhd2VyIC0tPgoKPC9kaXY+PCEtLSAvYm9keS13cmFwIC0tPgo8L2Rpdj48IS0tIC9hcHAgLS0+Cgo8c2NyaXB0PgogIC8vIDEpIENvbnN0YW50ZXMgeSBjb25maWd1cmFjacOzbgogIGNvbnN0IEVORFBPSU5UUyA9IHsKICAgIG1lcENjbDogJy9hcGkvZGF0YScsCiAgICBleHRyYXM6ICcvYXBpL2V4dHJhcycKICB9OwogIGNvbnN0IEFSR19UWiA9ICdBbWVyaWNhL0FyZ2VudGluYS9CdWVub3NfQWlyZXMnOwogIGNvbnN0IEZFVENIX0lOVEVSVkFMX01TID0gMzAwMDAwOwogIGNvbnN0IENBQ0hFX0tFWSA9ICdyYWRhcl9jYWNoZSc7CiAgY29uc3QgQ0FDSEVfVFRMX01TID0gMTUgKiA2MCAqIDEwMDA7CiAgY29uc3QgUkVUUllfREVMQVlTID0gWzEwMDAwLCAzMDAwMCwgNjAwMDBdOwogIGNvbnN0IFNJTUlMQVJfUENUX1RIUkVTSE9MRCA9IDE7CiAgY29uc3QgU0lNSUxBUl9BUlNfVEhSRVNIT0xEID0gMTA7CiAgY29uc3QgVFJFTkRfUE9JTlRTID0gNDA7CiAgY29uc3QgSElTVE9SWV9ST1dTX0xJTUlUID0gODsKICBjb25zdCBCT05PX1RJQ0tFUlMgPSBbJ0FMMzAnLCAnR0QzMCcsICdBTDM1JywgJ0dEMzUnLCAnR0Q0MSddOwogIGNvbnN0IExFVFJBX1JPV1MgPSBbCiAgICB7IGlkOiAnTEVERS1GRUIyNScsIG1hdGNoOiBbJ0xFREUnLCAnRkVCJywgJzI1J10sIG1vZGU6ICdUTkEnIH0sCiAgICB7IGlkOiAnTEVDQVAtTUFSMjUnLCBtYXRjaDogWydMRUNBUCcsICdNQVInLCAnMjUnXSwgbW9kZTogJ1RFTScgfSwKICAgIHsgaWQ6ICdMRUNBUC1NQVkyNScsIG1hdGNoOiBbJ0xFQ0FQJywgJ01BWScsICcyNSddLCBtb2RlOiAnVEVNJyB9CiAgXTsKICBjb25zdCBOVU1FUklDX0lEUyA9IFsKICAgICdtZXAtdmFsJywgJ2NjbC12YWwnLCAnYnJlY2hhLWFicycsICdicmVjaGEtcGN0JywKICAgICdjYXVjaW9uLTFkLXRuYScsICdjYXVjaW9uLTFkLWRlbHRhJywgJ2NhdWNpb24tN2QtdG5hJywgJ2NhdWNpb24tN2QtZGVsdGEnLAogICAgJ2NhdWNpb24tMzBkLXRuYScsICdjYXVjaW9uLTMwZC1kZWx0YScsICdjYXVjaW9uLXRlYS0zMGQnLAogICAgJ2Jvbm8tQUwzMC10aXInLCAnYm9uby1BTDMwLXByZWNpbycsICdib25vLUFMMzAtdmFyJywKICAgICdib25vLUdEMzAtdGlyJywgJ2Jvbm8tR0QzMC1wcmVjaW8nLCAnYm9uby1HRDMwLXZhcicsCiAgICAnYm9uby1BTDM1LXRpcicsICdib25vLUFMMzUtcHJlY2lvJywgJ2Jvbm8tQUwzNS12YXInLAogICAgJ2Jvbm8tR0QzNS10aXInLCAnYm9uby1HRDM1LXByZWNpbycsICdib25vLUdEMzUtdmFyJywKICAgICdib25vLUdENDEtdGlyJywgJ2Jvbm8tR0Q0MS1wcmVjaW8nLCAnYm9uby1HRDQxLXZhcicsCiAgICAnbGV0cmEtTEVERS1GRUIyNS10bmEnLCAnbGV0cmEtTEVERS1GRUIyNS10ZWEnLCAnbGV0cmEtTEVERS1GRUIyNS12dG8nLAogICAgJ2xldHJhLUxFQ0FQLU1BUjI1LXRuYScsICdsZXRyYS1MRUNBUC1NQVIyNS10ZWEnLCAnbGV0cmEtTEVDQVAtTUFSMjUtdnRvJywKICAgICdsZXRyYS1MRUNBUC1NQVkyNS10bmEnLCAnbGV0cmEtTEVDQVAtTUFZMjUtdGVhJywgJ2xldHJhLUxFQ0FQLU1BWTI1LXZ0bycKICBdOwogIGNvbnN0IHN0YXRlID0gewogICAgcmV0cnlJbmRleDogMCwKICAgIHJldHJ5VGltZXI6IG51bGwsCiAgICBsYXN0U3VjY2Vzc0F0OiAwLAogICAgaXNGZXRjaGluZzogZmFsc2UsCiAgICBsYXRlc3Q6IHsKICAgICAgbWVwOiBudWxsLAogICAgICBjY2w6IG51bGwsCiAgICAgIGJyZWNoYUFiczogbnVsbCwKICAgICAgYnJlY2hhUGN0OiBudWxsLAogICAgICBjYXVjaW9uMWQ6IG51bGwsCiAgICAgIGFsMzBUaXI6IG51bGwKICAgIH0KICB9OwoKICAvLyAyKSBIZWxwZXJzCiAgY29uc3QgZm10QXJnVGltZSA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlcy1BUicsIHsKICAgIHRpbWVab25lOiBBUkdfVFosCiAgICBob3VyOiAnMi1kaWdpdCcsCiAgICBtaW51dGU6ICcyLWRpZ2l0JwogIH0pOwogIGNvbnN0IGZtdEFyZ1RpbWVTZWMgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZXMtQVInLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgaG91cjogJzItZGlnaXQnLAogICAgbWludXRlOiAnMi1kaWdpdCcsCiAgICBzZWNvbmQ6ICcyLWRpZ2l0JwogIH0pOwogIGNvbnN0IGZtdEFyZ0hvdXIgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZXMtQVInLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgaG91cjogJzItZGlnaXQnLAogICAgbWludXRlOiAnMi1kaWdpdCcsCiAgICBob3VyMTI6IGZhbHNlCiAgfSk7CiAgY29uc3QgZm10QXJnUGFydHMgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZW4tVVMnLCB7CiAgICB0aW1lWm9uZTogQVJHX1RaLAogICAgd2Vla2RheTogJ3Nob3J0JywKICAgIGhvdXI6ICcyLWRpZ2l0JywKICAgIG1pbnV0ZTogJzItZGlnaXQnLAogICAgc2Vjb25kOiAnMi1kaWdpdCcsCiAgICBob3VyMTI6IGZhbHNlCiAgfSk7CiAgY29uc3QgV0VFS0RBWSA9IHsgTW9uOiAxLCBUdWU6IDIsIFdlZDogMywgVGh1OiA0LCBGcmk6IDUsIFNhdDogNiwgU3VuOiA3IH07CgogIGZ1bmN0aW9uIHRvTnVtYmVyKHZhbHVlKSB7CiAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpKSByZXR1cm4gdmFsdWU7CiAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykgewogICAgICBjb25zdCBub3JtYWxpemVkID0gdmFsdWUucmVwbGFjZSgvXHMvZywgJycpLnJlcGxhY2UoJywnLCAnLicpLnJlcGxhY2UoL1teXGQuLV0vZywgJycpOwogICAgICBjb25zdCBwYXJzZWQgPSBOdW1iZXIobm9ybWFsaXplZCk7CiAgICAgIHJldHVybiBOdW1iZXIuaXNGaW5pdGUocGFyc2VkKSA/IHBhcnNlZCA6IG51bGw7CiAgICB9CiAgICByZXR1cm4gbnVsbDsKICB9CiAgZnVuY3Rpb24gYXNBcnJheSh2YWx1ZSkgewogICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSByZXR1cm4gdmFsdWU7CiAgICBpZiAodmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0JykgcmV0dXJuIE9iamVjdC52YWx1ZXModmFsdWUpOwogICAgcmV0dXJuIFtdOwogIH0KICBmdW5jdGlvbiBub3JtYWxpemVUaWNrZXIodmFsdWUpIHsKICAgIHJldHVybiBTdHJpbmcodmFsdWUgfHwgJycpLnRvVXBwZXJDYXNlKCkucmVwbGFjZSgvW15BLVowLTldL2csICcnKTsKICB9CiAgZnVuY3Rpb24gZ2V0UGF0aChvYmosIHBhdGgpIHsKICAgIHJldHVybiBwYXRoLnJlZHVjZSgoYWNjLCBrZXkpID0+IChhY2MgJiYgYWNjW2tleV0gIT09IHVuZGVmaW5lZCA/IGFjY1trZXldIDogdW5kZWZpbmVkKSwgb2JqKTsKICB9CiAgZnVuY3Rpb24gcGlja051bWJlcihvYmosIHBhdGhzKSB7CiAgICBmb3IgKGNvbnN0IHBhdGggb2YgcGF0aHMpIHsKICAgICAgY29uc3QgdiA9IGdldFBhdGgob2JqLCBwYXRoKTsKICAgICAgY29uc3QgbiA9IHRvTnVtYmVyKHYpOwogICAgICBpZiAobiAhPT0gbnVsbCkgcmV0dXJuIG47CiAgICB9CiAgICByZXR1cm4gbnVsbDsKICB9CiAgZnVuY3Rpb24gcGlja0J5S2V5SGludChvYmosIGhpbnQpIHsKICAgIGlmICghb2JqIHx8IHR5cGVvZiBvYmogIT09ICdvYmplY3QnKSByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGxvd2VyID0gaGludC50b0xvd2VyQ2FzZSgpOwogICAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXMob2JqKSkgewogICAgICBpZiAoay50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKGxvd2VyKSkgewogICAgICAgIGNvbnN0IG4gPSB0b051bWJlcih2KTsKICAgICAgICBpZiAobiAhPT0gbnVsbCkgcmV0dXJuIG47CiAgICAgICAgaWYgKHYgJiYgdHlwZW9mIHYgPT09ICdvYmplY3QnKSB7CiAgICAgICAgICBjb25zdCBkZWVwID0gcGlja0J5S2V5SGludCh2LCBoaW50KTsKICAgICAgICAgIGlmIChkZWVwICE9PSBudWxsKSByZXR1cm4gZGVlcDsKICAgICAgICB9CiAgICAgIH0KICAgICAgaWYgKHYgJiYgdHlwZW9mIHYgPT09ICdvYmplY3QnKSB7CiAgICAgICAgY29uc3QgZGVlcCA9IHBpY2tCeUtleUhpbnQodiwgaGludCk7CiAgICAgICAgaWYgKGRlZXAgIT09IG51bGwpIHJldHVybiBkZWVwOwogICAgICB9CiAgICB9CiAgICByZXR1cm4gbnVsbDsKICB9CiAgZnVuY3Rpb24gZ2V0QXJnTm93UGFydHMoZGF0ZSA9IG5ldyBEYXRlKCkpIHsKICAgIGNvbnN0IHBhcnRzID0gZm10QXJnUGFydHMuZm9ybWF0VG9QYXJ0cyhkYXRlKS5yZWR1Y2UoKGFjYywgcCkgPT4gewogICAgICBhY2NbcC50eXBlXSA9IHAudmFsdWU7CiAgICAgIHJldHVybiBhY2M7CiAgICB9LCB7fSk7CiAgICByZXR1cm4gewogICAgICB3ZWVrZGF5OiBXRUVLREFZW3BhcnRzLndlZWtkYXldIHx8IDAsCiAgICAgIGhvdXI6IE51bWJlcihwYXJ0cy5ob3VyIHx8ICcwJyksCiAgICAgIG1pbnV0ZTogTnVtYmVyKHBhcnRzLm1pbnV0ZSB8fCAnMCcpLAogICAgICBzZWNvbmQ6IE51bWJlcihwYXJ0cy5zZWNvbmQgfHwgJzAnKQogICAgfTsKICB9CiAgZnVuY3Rpb24gdG5hVG9UZWFQZXJjZW50KHRuYVBlcmNlbnQpIHsKICAgIGlmICh0bmFQZXJjZW50ID09PSBudWxsKSByZXR1cm4gbnVsbDsKICAgIHJldHVybiAoTWF0aC5wb3coMSArICh0bmFQZXJjZW50IC8gMTAwKSAvIDM2NSwgMzY1KSAtIDEpICogMTAwOwogIH0KICBmdW5jdGlvbiB0ZW1Ub1RlYVBlcmNlbnQodGVtUGVyY2VudCkgewogICAgaWYgKHRlbVBlcmNlbnQgPT09IG51bGwpIHJldHVybiBudWxsOwogICAgcmV0dXJuIChNYXRoLnBvdygxICsgKHRlbVBlcmNlbnQgLyAxMDApLCAxMikgLSAxKSAqIDEwMDsKICB9CiAgZnVuY3Rpb24gYnJlY2hhUGVyY2VudChtZXAsIGNjbCkgewogICAgaWYgKG1lcCA9PT0gbnVsbCB8fCBjY2wgPT09IG51bGwpIHJldHVybiBudWxsOwogICAgY29uc3QgYXZnID0gKG1lcCArIGNjbCkgLyAyOwogICAgaWYgKCFhdmcpIHJldHVybiBudWxsOwogICAgcmV0dXJuIChNYXRoLmFicyhtZXAgLSBjY2wpIC8gYXZnKSAqIDEwMDsKICB9CiAgZnVuY3Rpb24gZm9ybWF0TW9uZXkodmFsdWUsIGRpZ2l0cyA9IDApIHsKICAgIGlmICh2YWx1ZSA9PT0gbnVsbCkgcmV0dXJuICfigJQnOwogICAgcmV0dXJuICckJyArIHZhbHVlLnRvTG9jYWxlU3RyaW5nKCdlcy1BUicsIHsKICAgICAgbWluaW11bUZyYWN0aW9uRGlnaXRzOiBkaWdpdHMsCiAgICAgIG1heGltdW1GcmFjdGlvbkRpZ2l0czogZGlnaXRzCiAgICB9KTsKICB9CiAgZnVuY3Rpb24gZm9ybWF0UGVyY2VudCh2YWx1ZSwgZGlnaXRzID0gMikgewogICAgaWYgKHZhbHVlID09PSBudWxsKSByZXR1cm4gJ+KAlCc7CiAgICByZXR1cm4gdmFsdWUudG9GaXhlZChkaWdpdHMpICsgJyUnOwogIH0KICBmdW5jdGlvbiBmb3JtYXREZWx0YVBQKHZhbHVlKSB7CiAgICBpZiAodmFsdWUgPT09IG51bGwpIHJldHVybiAn4oCUJzsKICAgIGlmICh2YWx1ZSA+IDApIHJldHVybiAn4payICsnICsgdmFsdWUudG9GaXhlZCgxKSArICdwcCc7CiAgICBpZiAodmFsdWUgPCAwKSByZXR1cm4gJ+KWvCAnICsgdmFsdWUudG9GaXhlZCgxKSArICdwcCc7CiAgICByZXR1cm4gJ+KAlCBzaW4gY2FtYmlvJzsKICB9CiAgZnVuY3Rpb24gc2V0VGV4dChpZCwgdGV4dCwgb3B0aW9ucyA9IHt9KSB7CiAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKTsKICAgIGlmICghZWwpIHJldHVybjsKICAgIGNvbnN0IG5leHQgPSBTdHJpbmcodGV4dCk7CiAgICBjb25zdCBwcmV2ID0gZWwudGV4dENvbnRlbnQ7CiAgICBlbC50ZXh0Q29udGVudCA9IG5leHQ7CiAgICBlbC5jbGFzc0xpc3QucmVtb3ZlKCdza2VsZXRvbicpOwogICAgaWYgKG9wdGlvbnMuY2hhbmdlQ2xhc3MgJiYgcHJldiAhPT0gbmV4dCkgewogICAgICBlbC5jbGFzc0xpc3QuYWRkKCd2YWx1ZS1jaGFuZ2VkJyk7CiAgICAgIHNldFRpbWVvdXQoKCkgPT4gZWwuY2xhc3NMaXN0LnJlbW92ZSgndmFsdWUtY2hhbmdlZCcpLCA2MDApOwogICAgfQogIH0KICBmdW5jdGlvbiBzZXREYXNoKGlkcykgewogICAgaWRzLmZvckVhY2goKGlkKSA9PiBzZXRUZXh0KGlkLCAn4oCUJykpOwogIH0KICBmdW5jdGlvbiBzZXRMb2FkaW5nKGlkcywgaXNMb2FkaW5nKSB7CiAgICBpZHMuZm9yRWFjaCgoaWQpID0+IHsKICAgICAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7CiAgICAgIGlmICghZWwpIHJldHVybjsKICAgICAgZWwuY2xhc3NMaXN0LnRvZ2dsZSgnc2tlbGV0b24nLCBpc0xvYWRpbmcpOwogICAgfSk7CiAgfQogIGZ1bmN0aW9uIHNldFZhckNsYXNzKGVsLCB2YWx1ZSkgewogICAgaWYgKCFlbCkgcmV0dXJuOwogICAgZWwuY2xhc3NMaXN0LnJlbW92ZSgndmFyLXBvcycsICd2YXItbmVnJywgJ2RlbHRhLWZsYXQnLCAnZGVsdGEtdXAnLCAnZGVsdGEtZG93bicpOwogICAgaWYgKHZhbHVlID09PSBudWxsIHx8IE1hdGguYWJzKHZhbHVlKSA8IDAuMDAwMDEpIHsKICAgICAgZWwuY2xhc3NMaXN0LmFkZCgnZGVsdGEtZmxhdCcpOwogICAgICByZXR1cm47CiAgICB9CiAgICBlbC5jbGFzc0xpc3QuYWRkKHZhbHVlID4gMCA/ICd2YXItcG9zJyA6ICd2YXItbmVnJyk7CiAgfQogIGZ1bmN0aW9uIHNldENhdWNpb25EZWx0YUNsYXNzKGVsLCB2YWx1ZSkgewogICAgaWYgKCFlbCkgcmV0dXJuOwogICAgZWwuY2xhc3NMaXN0LnJlbW92ZSgnZGVsdGEtdXAnLCAnZGVsdGEtZG93bicsICdkZWx0YS1mbGF0Jyk7CiAgICBpZiAodmFsdWUgPT09IG51bGwgfHwgTWF0aC5hYnModmFsdWUpIDwgMC4wMDAwMSkgewogICAgICBlbC5jbGFzc0xpc3QuYWRkKCdkZWx0YS1mbGF0Jyk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGVsLmNsYXNzTGlzdC5hZGQodmFsdWUgPiAwID8gJ2RlbHRhLXVwJyA6ICdkZWx0YS1kb3duJyk7CiAgfQogIGZ1bmN0aW9uIHNldEZyZXNoQmFkZ2UodGV4dCwgbW9kZSkgewogICAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZnJlc2gtYmFkZ2UnKTsKICAgIGNvbnN0IGxhYmVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZyZXNoLWJhZGdlLXRleHQnKTsKICAgIGlmICghYmFkZ2UgfHwgIWxhYmVsKSByZXR1cm47CiAgICBsYWJlbC50ZXh0Q29udGVudCA9IHRleHQ7CiAgICBiYWRnZS5jbGFzc0xpc3QudG9nZ2xlKCdmZXRjaGluZycsIG1vZGUgPT09ICdmZXRjaGluZycpOwogICAgYmFkZ2UuY2xhc3NMaXN0LnRvZ2dsZSgnZXJyb3InLCBtb2RlID09PSAnZXJyb3InKTsKICAgIGJhZGdlLm9uY2xpY2sgPSBtb2RlID09PSAnZXJyb3InID8gKCkgPT4gZmV0Y2hBbGwoeyBtYW51YWw6IHRydWUgfSkgOiBudWxsOwogIH0KICBmdW5jdGlvbiBzZXRNYXJrZXRUYWcoaXNPcGVuKSB7CiAgICBjb25zdCB0YWcgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndGFnLW1lcmNhZG8nKTsKICAgIGlmICghdGFnKSByZXR1cm47CiAgICB0YWcudGV4dENvbnRlbnQgPSBpc09wZW4gPyAnTWVyY2FkbyBhYmllcnRvJyA6ICdNZXJjYWRvIGNlcnJhZG8nOwogICAgdGFnLmNsYXNzTGlzdC50b2dnbGUoJ2Nsb3NlZCcsICFpc09wZW4pOwogIH0KICBmdW5jdGlvbiBzZXRFcnJvckJhbm5lcihzaG93LCB0ZXh0KSB7CiAgICBjb25zdCBiYW5uZXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZXJyb3ItYmFubmVyJyk7CiAgICBjb25zdCBsYWJlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdlcnJvci1iYW5uZXItdGV4dCcpOwogICAgaWYgKCFiYW5uZXIpIHJldHVybjsKICAgIGlmICh0ZXh0ICYmIGxhYmVsKSBsYWJlbC50ZXh0Q29udGVudCA9IHRleHQ7CiAgICBiYW5uZXIuY2xhc3NMaXN0LnRvZ2dsZSgnc2hvdycsICEhc2hvdyk7CiAgfQogIGZ1bmN0aW9uIGV4dHJhY3RSb290KGpzb24pIHsKICAgIHJldHVybiBqc29uICYmIHR5cGVvZiBqc29uID09PSAnb2JqZWN0JyA/IChqc29uLmRhdGEgfHwganNvbi5yZXN1bHQgfHwganNvbikgOiB7fTsKICB9CgogIC8vIDMpIEZ1bmNpb25lcyBkZSByZW5kZXIKICBmdW5jdGlvbiByZW5kZXJNZXBDY2wocGF5bG9hZCkgewogICAgaWYgKCFwYXlsb2FkKSB7CiAgICAgIHNldERhc2goWydtZXAtdmFsJywgJ2NjbC12YWwnLCAnYnJlY2hhLWFicycsICdicmVjaGEtcGN0J10pOwogICAgICBzZXRUZXh0KCdzdGF0dXMtbGFiZWwnLCAnRGF0b3MgaW5jb21wbGV0b3MnKTsKICAgICAgc2V0VGV4dCgnc3RhdHVzLWJhZGdlJywgJ1NpbiBkYXRvJyk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IGRhdGEgPSBleHRyYWN0Um9vdChwYXlsb2FkKTsKICAgIGNvbnN0IGN1cnJlbnQgPSBkYXRhICYmIHR5cGVvZiBkYXRhLmN1cnJlbnQgPT09ICdvYmplY3QnID8gZGF0YS5jdXJyZW50IDogbnVsbDsKICAgIGNvbnN0IG1lcCA9IGN1cnJlbnQgPyB0b051bWJlcihjdXJyZW50Lm1lcCkgOiAocGlja051bWJlcihkYXRhLCBbWydtZXAnLCAndmVudGEnXSwgWydtZXAnLCAnc2VsbCddLCBbJ21lcCddLCBbJ21lcF92ZW50YSddLCBbJ2RvbGFyX21lcCddXSkgPz8gcGlja0J5S2V5SGludChkYXRhLCAnbWVwJykpOwogICAgY29uc3QgY2NsID0gY3VycmVudCA/IHRvTnVtYmVyKGN1cnJlbnQuY2NsKSA6IChwaWNrTnVtYmVyKGRhdGEsIFtbJ2NjbCcsICd2ZW50YSddLCBbJ2NjbCcsICdzZWxsJ10sIFsnY2NsJ10sIFsnY2NsX3ZlbnRhJ10sIFsnZG9sYXJfY2NsJ11dKSA/PyBwaWNrQnlLZXlIaW50KGRhdGEsICdjY2wnKSk7CiAgICBjb25zdCBhYnMgPSBjdXJyZW50ID8gdG9OdW1iZXIoY3VycmVudC5hYnNEaWZmKSA/PyAobWVwICE9PSBudWxsICYmIGNjbCAhPT0gbnVsbCA/IE1hdGguYWJzKG1lcCAtIGNjbCkgOiBudWxsKSA6IChtZXAgIT09IG51bGwgJiYgY2NsICE9PSBudWxsID8gTWF0aC5hYnMobWVwIC0gY2NsKSA6IG51bGwpOwogICAgY29uc3QgcGN0ID0gY3VycmVudCA/IHRvTnVtYmVyKGN1cnJlbnQucGN0RGlmZikgPz8gYnJlY2hhUGVyY2VudChtZXAsIGNjbCkgOiBicmVjaGFQZXJjZW50KG1lcCwgY2NsKTsKICAgIGNvbnN0IGlzU2ltaWxhciA9IGN1cnJlbnQgJiYgdHlwZW9mIGN1cnJlbnQuc2ltaWxhciA9PT0gJ2Jvb2xlYW4nCiAgICAgID8gY3VycmVudC5zaW1pbGFyCiAgICAgIDogKHBjdCAhPT0gbnVsbCAmJiBhYnMgIT09IG51bGwgJiYgKHBjdCA8PSBTSU1JTEFSX1BDVF9USFJFU0hPTEQgfHwgYWJzIDw9IFNJTUlMQVJfQVJTX1RIUkVTSE9MRCkpOwoKICAgIHNldFRleHQoJ21lcC12YWwnLCBmb3JtYXRNb25leShtZXAsIDIpLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc2V0VGV4dCgnY2NsLXZhbCcsIGZvcm1hdE1vbmV5KGNjbCwgMiksIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdicmVjaGEtYWJzJywgYWJzID09PSBudWxsID8gJ+KAlCcgOiBmb3JtYXRNb25leShhYnMsIDIpLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc2V0VGV4dCgnYnJlY2hhLXBjdCcsIGZvcm1hdFBlcmNlbnQocGN0LCAyKSwgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ3N0YXR1cy1sYWJlbCcsIGlzU2ltaWxhciA/ICdNRVAg4omIIENDTCcgOiAnTUVQIOKJoCBDQ0wnKTsKICAgIHNldFRleHQoJ3N0YXR1cy1iYWRnZScsIGlzU2ltaWxhciA/ICdTaW1pbGFyJyA6ICdObyBzaW1pbGFyJyk7CiAgICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzdGF0dXMtYmFkZ2UnKTsKICAgIGlmIChiYWRnZSkgYmFkZ2UuY2xhc3NMaXN0LnRvZ2dsZSgnbm9zaW0nLCAhaXNTaW1pbGFyKTsKCiAgICBjb25zdCBiYW5uZXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3RhdHVzLWJhbm5lcicpOwogICAgaWYgKGJhbm5lcikgewogICAgICBiYW5uZXIuY2xhc3NMaXN0LnRvZ2dsZSgnc2ltaWxhcicsICEhaXNTaW1pbGFyKTsKICAgICAgYmFubmVyLmNsYXNzTGlzdC50b2dnbGUoJ25vLXNpbWlsYXInLCAhaXNTaW1pbGFyKTsKICAgIH0KICAgIGNvbnN0IHN1YiA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJyNzdGF0dXMtYmFubmVyIC5zLXN1YicpOwogICAgaWYgKHN1YikgewogICAgICBzdWIudGV4dENvbnRlbnQgPSBpc1NpbWlsYXIKICAgICAgICA/ICdMYSBicmVjaGEgZXN0w6EgZGVudHJvIGRlbCB1bWJyYWwg4oCUIGxvcyBwcmVjaW9zIHNvbiBjb21wYXJhYmxlcycKICAgICAgICA6ICdMYSBicmVjaGEgc3VwZXJhIGVsIHVtYnJhbCDigJQgbG9zIHByZWNpb3Mgbm8gc29uIGNvbXBhcmFibGVzJzsKICAgIH0KICAgIGNvbnN0IGlzT3BlbiA9IGRhdGE/Lm1hcmtldCAmJiB0eXBlb2YgZGF0YS5tYXJrZXQuaXNPcGVuID09PSAnYm9vbGVhbicgPyBkYXRhLm1hcmtldC5pc09wZW4gOiBudWxsOwogICAgaWYgKGlzT3BlbiAhPT0gbnVsbCkgc2V0TWFya2V0VGFnKGlzT3Blbik7CiAgICBzdGF0ZS5sYXRlc3QubWVwID0gbWVwOwogICAgc3RhdGUubGF0ZXN0LmNjbCA9IGNjbDsKICAgIHN0YXRlLmxhdGVzdC5icmVjaGFBYnMgPSBhYnM7CiAgICBzdGF0ZS5sYXRlc3QuYnJlY2hhUGN0ID0gcGN0OwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyQ2F1Y2lvbmVzKHBheWxvYWQpIHsKICAgIGNvbnN0IGlkcyA9IFsKICAgICAgJ2NhdWNpb24tMWQtdG5hJywgJ2NhdWNpb24tMWQtZGVsdGEnLCAnY2F1Y2lvbi03ZC10bmEnLAogICAgICAnY2F1Y2lvbi03ZC1kZWx0YScsICdjYXVjaW9uLTMwZC10bmEnLCAnY2F1Y2lvbi0zMGQtZGVsdGEnLCAnY2F1Y2lvbi10ZWEtMzBkJwogICAgXTsKICAgIGlmICghcGF5bG9hZCkgewogICAgICBzZXREYXNoKGlkcyk7CiAgICAgIHN0YXRlLmxhdGVzdC5jYXVjaW9uMWQgPSBudWxsOwogICAgICByZXR1cm47CiAgICB9CiAgICBjb25zdCBkYXRhID0gZXh0cmFjdFJvb3QocGF5bG9hZCk7CiAgICBjb25zdCByb3dzID0gYXNBcnJheShkYXRhLmNhdWNpb25lcyB8fCBkYXRhLnRhc2FzIHx8IGRhdGEpOwogICAgY29uc3QgYnlEYXlzID0geyAxOiBudWxsLCA3OiBudWxsLCAzMDogbnVsbCB9OwoKICAgIHJvd3MuZm9yRWFjaCgocmF3KSA9PiB7CiAgICAgIGlmICghcmF3IHx8IHR5cGVvZiByYXcgIT09ICdvYmplY3QnKSByZXR1cm47CiAgICAgIGNvbnN0IHBsYXpvID0gdG9OdW1iZXIocmF3LnBsYXpvID8/IHJhdy5kaWFzID8/IHJhdy5kYXlzID8/IHJhdy50ZXJtKTsKICAgICAgY29uc3QgdG5hID0gdG9OdW1iZXIocmF3LnRuYSA/PyByYXcudGFzYV9ub21pbmFsID8/IHJhdy50YXNhID8/IHJhdy5yYXRlID8/IHJhdy52YWxvcik7CiAgICAgIGNvbnN0IGRlbHRhID0gdG9OdW1iZXIocmF3LmRlbHRhID8/IHJhdy52YXJpYWNpb24gPz8gcmF3LnZhciA/PyByYXcuY2hhbmdlKTsKICAgICAgaWYgKHBsYXpvID09PSAxIHx8IHBsYXpvID09PSA3IHx8IHBsYXpvID09PSAzMCkgYnlEYXlzW3BsYXpvXSA9IHsgdG5hLCBkZWx0YSB9OwogICAgfSk7CiAgICBpZiAoIWJ5RGF5c1sxXSB8fCAhYnlEYXlzWzddIHx8ICFieURheXNbMzBdKSB7CiAgICAgIE9iamVjdC5lbnRyaWVzKGRhdGEpLmZvckVhY2goKFtrLCB2XSkgPT4gewogICAgICAgIGNvbnN0IGtleSA9IFN0cmluZyhrKS50b0xvd2VyQ2FzZSgpOwogICAgICAgIGNvbnN0IG1hdGNoZWQgPSBrZXkuaW5jbHVkZXMoJzEnKSA/IDEgOiAoa2V5LmluY2x1ZGVzKCc3JykgPyA3IDogKGtleS5pbmNsdWRlcygnMzAnKSA/IDMwIDogbnVsbCkpOwogICAgICAgIGlmICghbWF0Y2hlZCB8fCBieURheXNbbWF0Y2hlZF0pIHJldHVybjsKICAgICAgICBieURheXNbbWF0Y2hlZF0gPSB7CiAgICAgICAgICB0bmE6IHRvTnVtYmVyKHY/LnRuYSA/PyB2Py50YXNhX25vbWluYWwgPz8gdj8ucmF0ZSA/PyB2KSwKICAgICAgICAgIGRlbHRhOiB0b051bWJlcih2Py5kZWx0YSA/PyB2Py52YXJpYWNpb24gPz8gdj8udmFyKQogICAgICAgIH07CiAgICAgIH0pOwogICAgfQoKICAgIFsxLCA3LCAzMF0uZm9yRWFjaCgoZCkgPT4gewogICAgICBjb25zdCByb3cgPSBieURheXNbZF07CiAgICAgIHNldFRleHQoYGNhdWNpb24tJHtkfWQtdG5hYCwgcm93ICYmIHJvdy50bmEgIT09IG51bGwgPyBmb3JtYXRQZXJjZW50KHJvdy50bmEsIDEpIDogJ+KAlCcsIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICAgIHNldFRleHQoYGNhdWNpb24tJHtkfWQtZGVsdGFgLCByb3cgPyBmb3JtYXREZWx0YVBQKHJvdy5kZWx0YSkgOiAn4oCUJywgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgICAgY29uc3QgZGVsdGFFbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGBjYXVjaW9uLSR7ZH1kLWRlbHRhYCk7CiAgICAgIHNldENhdWNpb25EZWx0YUNsYXNzKGRlbHRhRWwsIHJvdyA/IHJvdy5kZWx0YSA6IG51bGwpOwogICAgfSk7CiAgICBjb25zdCB0ZWEzMCA9IHRuYVRvVGVhUGVyY2VudChieURheXNbMzBdICYmIGJ5RGF5c1szMF0udG5hICE9PSBudWxsID8gYnlEYXlzWzMwXS50bmEgOiBudWxsKTsKICAgIHNldFRleHQoJ2NhdWNpb24tdGVhLTMwZCcsIGZvcm1hdFBlcmNlbnQodGVhMzAsIDEpLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc3RhdGUubGF0ZXN0LmNhdWNpb24xZCA9IGJ5RGF5c1sxXSA/IGJ5RGF5c1sxXS50bmEgOiBudWxsOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyQm9ub3MocGF5bG9hZCkgewogICAgaWYgKCFwYXlsb2FkKSB7CiAgICAgIEJPTk9fVElDS0VSUy5mb3JFYWNoKCh0KSA9PiBzZXREYXNoKFtgYm9uby0ke3R9LXRpcmAsIGBib25vLSR7dH0tcHJlY2lvYCwgYGJvbm8tJHt0fS12YXJgXSkpOwogICAgICBzdGF0ZS5sYXRlc3QuYWwzMFRpciA9IG51bGw7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IGRhdGEgPSBleHRyYWN0Um9vdChwYXlsb2FkKTsKICAgIGNvbnN0IGxpc3QgPSBhc0FycmF5KGRhdGEuYm9ub3MgfHwgZGF0YSk7CgogICAgQk9OT19USUNLRVJTLmZvckVhY2goKHRpY2tlcikgPT4gewogICAgICBjb25zdCBpdGVtID0gbGlzdC5maW5kKChyb3cpID0+IHsKICAgICAgICBjb25zdCBpZCA9IG5vcm1hbGl6ZVRpY2tlcihyb3c/LnRpY2tlciB8fCByb3c/LnNpbWJvbG8gfHwgcm93Py5zeW1ib2wgfHwgcm93Py5ib25vIHx8IHJvdz8ubm9tYnJlKTsKICAgICAgICByZXR1cm4gaWQuaW5jbHVkZXModGlja2VyKTsKICAgICAgfSkgfHwgZGF0YVt0aWNrZXJdIHx8IGRhdGFbdGlja2VyLnRvTG93ZXJDYXNlKCldIHx8IG51bGw7CiAgICAgIGNvbnN0IHRpciA9IHRvTnVtYmVyKGl0ZW0/LnRpciA/PyBpdGVtPy55aWVsZCA/PyBpdGVtPy55dG0pOwogICAgICBjb25zdCBwcmVjaW8gPSB0b051bWJlcihpdGVtPy5wcmVjaW8gPz8gaXRlbT8ucHJpY2UgPz8gaXRlbT8udWx0aW1vID8/IGl0ZW0/Lmxhc3QpOwogICAgICBjb25zdCB2YXJpYWNpb24gPSB0b051bWJlcihpdGVtPy52YXJpYWNpb24gPz8gaXRlbT8udmFyID8/IGl0ZW0/LmNoYW5nZSA/PyBpdGVtPy5kYWlseV9jaGFuZ2UpOwogICAgICBzZXRUZXh0KGBib25vLSR7dGlja2VyfS10aXJgLCBmb3JtYXRQZXJjZW50KHRpciwgMSksIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICAgIHNldFRleHQoYGJvbm8tJHt0aWNrZXJ9LXByZWNpb2AsIHByZWNpbyA9PT0gbnVsbCA/ICfigJQnIDogcHJlY2lvLnRvRml4ZWQoMiksIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICAgIHNldFRleHQoYGJvbm8tJHt0aWNrZXJ9LXZhcmAsIHZhcmlhY2lvbiA9PT0gbnVsbCA/ICfigJQnIDogKHZhcmlhY2lvbiA+IDAgPyAnKycgOiAnJykgKyB2YXJpYWNpb24udG9GaXhlZCgxKSArICclJywgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgICAgY29uc3QgdmFyRWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChgYm9uby0ke3RpY2tlcn0tdmFyYCk7CiAgICAgIHNldFZhckNsYXNzKHZhckVsLCB2YXJpYWNpb24pOwogICAgICBpZiAodGlja2VyID09PSAnQUwzMCcpIHN0YXRlLmxhdGVzdC5hbDMwVGlyID0gdGlyOwogICAgfSk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJMZXRyYXMocGF5bG9hZCkgewogICAgaWYgKCFwYXlsb2FkKSB7CiAgICAgIExFVFJBX1JPV1MuZm9yRWFjaCgocm93KSA9PiBzZXREYXNoKFtgbGV0cmEtJHtyb3cuaWR9LXRuYWAsIGBsZXRyYS0ke3Jvdy5pZH0tdGVhYCwgYGxldHJhLSR7cm93LmlkfS12dG9gXSkpOwogICAgICByZXR1cm47CiAgICB9CiAgICBjb25zdCBkYXRhID0gZXh0cmFjdFJvb3QocGF5bG9hZCk7CiAgICBjb25zdCBsaXN0ID0gYXNBcnJheShkYXRhLmxldHJhcyB8fCBkYXRhKTsKICAgIExFVFJBX1JPV1MuZm9yRWFjaCgocm93KSA9PiB7CiAgICAgIGNvbnN0IGl0ZW0gPSBsaXN0LmZpbmQoKGl0KSA9PiB7CiAgICAgICAgY29uc3QgdGV4dCA9IG5vcm1hbGl6ZVRpY2tlcihpdD8udGlja2VyIHx8IGl0Py5zaW1ib2xvIHx8IGl0Py5zeW1ib2wgfHwgaXQ/Lm5vbWJyZSB8fCBpdD8uZGVzY3JpcGNpb24pOwogICAgICAgIHJldHVybiByb3cubWF0Y2guZXZlcnkoKHRva2VuKSA9PiB0ZXh0LmluY2x1ZGVzKHRva2VuKSk7CiAgICAgIH0pIHx8IGRhdGFbcm93LmlkXSB8fCBkYXRhW3Jvdy5pZC50b0xvd2VyQ2FzZSgpXSB8fCBudWxsOwoKICAgICAgLy8gQXN1bW8gY29udHJhdG8gZmxleGlibGU6IGxhIEFQSSBwdWVkZSB0cmFlciB0YXNhIGVuICJ0bmEiIG8gInRlbSIgc2Vnw7puIGluc3RydW1lbnRvLgogICAgICBjb25zdCB0bmEgPSB0b051bWJlcihpdGVtPy50bmEgPz8gaXRlbT8udGFzYV9ub21pbmFsID8/IGl0ZW0/LnJhdGUpOwogICAgICBjb25zdCB0ZW0gPSB0b051bWJlcihpdGVtPy50ZW0gPz8gaXRlbT8udGFzYV9lZmVjdGl2YV9tZW5zdWFsKTsKICAgICAgY29uc3QgdGVhQXBpID0gdG9OdW1iZXIoaXRlbT8udGVhKTsKICAgICAgY29uc3QgdGVhID0gdGVhQXBpICE9PSBudWxsID8gdGVhQXBpIDogKHRlbSAhPT0gbnVsbCA/IHRlbVRvVGVhUGVyY2VudCh0ZW0pIDogdG5hVG9UZWFQZXJjZW50KHRuYSkpOwogICAgICBjb25zdCByYXRlVmFsID0gcm93Lm1vZGUgPT09ICdURU0nID8gKHRlbSAhPT0gbnVsbCA/IHRlbSA6IHRuYSkgOiB0bmE7CiAgICAgIGNvbnN0IHZlbmMgPSBpdGVtPy52dG8gPz8gaXRlbT8udmVuY2ltaWVudG8gPz8gaXRlbT8uZmVjaGFfdnRvID8/IGl0ZW0/Lm1hdHVyaXR5ID8/IG51bGw7CgogICAgICBzZXRUZXh0KGBsZXRyYS0ke3Jvdy5pZH0tdG5hYCwgZm9ybWF0UGVyY2VudChyYXRlVmFsLCAxKSwgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgICAgc2V0VGV4dChgbGV0cmEtJHtyb3cuaWR9LXRlYWAsIGZvcm1hdFBlcmNlbnQodGVhLCAxKSwgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgICAgc2V0VGV4dChgbGV0cmEtJHtyb3cuaWR9LXZ0b2AsIHZlbmMgPyBgVnRvOiAke1N0cmluZyh2ZW5jKX1gIDogJ+KAlCcsIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICB9KTsKICB9CgogIGZ1bmN0aW9uIHJlbmRlckNvbnRleHRCb3goKSB7CiAgICBjb25zdCBib3ggPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY29udGV4dC1ib3gnKTsKICAgIGlmICghYm94KSByZXR1cm47CiAgICBjb25zdCBjMSA9IHN0YXRlLmxhdGVzdC5jYXVjaW9uMWQ7CiAgICBjb25zdCBhbDMwID0gc3RhdGUubGF0ZXN0LmFsMzBUaXI7CiAgICBjb25zdCBiID0gc3RhdGUubGF0ZXN0LmJyZWNoYVBjdDsKICAgIGlmIChjMSA9PT0gbnVsbCB8fCBhbDMwID09PSBudWxsIHx8IGIgPT09IG51bGwpIHsKICAgICAgYm94LmlubmVySFRNTCA9ICfwn5KhIDxzdHJvbmc+Q29udGV4dG86PC9zdHJvbmc+IERhdG9zIGluY29tcGxldG9zIHBhcmEgZ2VuZXJhciB1bmEgbGVjdHVyYSBjcnV6YWRhLic7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IGFjY2lvbiA9IGIgPD0gU0lNSUxBUl9QQ1RfVEhSRVNIT0xECiAgICAgID8gJ3N1Z2llcmUgcGFyaWRhZCBvcGVyYXRpdmEgeSB2ZW50YW5hIHBhcmEgYXJiaXRyYWplIHTDoWN0aWNvIGRlIGNvcnRvIHBsYXpvLicKICAgICAgOiAnbXVlc3RyYSBkZXNhY29wbGUsIGNvbnZpZW5lIGNhdXRlbGEgeSBwcmlvcml6YXIgY29iZXJ0dXJhIGhhc3RhIG5vcm1hbGl6YWNpw7NuLic7CiAgICBib3guaW5uZXJIVE1MID0gYPCfkqEgPHN0cm9uZz5Db250ZXh0bzo8L3N0cm9uZz4gQ29uIGNhdWNpw7NuIDFkIGVuIDxzdHJvbmc+JHtmb3JtYXRQZXJjZW50KGMxLCAxKX0gVE5BPC9zdHJvbmc+LCBBTDMwIGVuIDxzdHJvbmc+JHtmb3JtYXRQZXJjZW50KGFsMzAsIDEpfSBUSVI8L3N0cm9uZz4geSBicmVjaGEgTUVQL0NDTCBlbiA8c3Ryb25nPiR7Zm9ybWF0UGVyY2VudChiLCAyKX08L3N0cm9uZz4sIGVsIGVzY2VuYXJpbyAke2FjY2lvbn1gOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyTWV0cmljczI0aChwYXlsb2FkKSB7CiAgICBjb25zdCBkYXRhID0gZXh0cmFjdFJvb3QocGF5bG9hZCk7CiAgICBjb25zdCBtZXRyaWNzID0gZGF0YSAmJiB0eXBlb2YgZGF0YS5tZXRyaWNzMjRoID09PSAnb2JqZWN0JyA/IGRhdGEubWV0cmljczI0aCA6IG51bGw7CiAgICBzZXRUZXh0KCdtZXRyaWMtY291bnQtMjRoJywgbWV0cmljcyA/IFN0cmluZyhtZXRyaWNzLmNvdW50ID8/ICfigJQnKSA6ICfigJQnLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogICAgc2V0VGV4dCgnbWV0cmljLXNpbWlsYXItMjRoJywgbWV0cmljcyA/IFN0cmluZyhtZXRyaWNzLnNpbWlsYXJDb3VudCA/PyAn4oCUJykgOiAn4oCUJywgeyBjaGFuZ2VDbGFzczogdHJ1ZSB9KTsKICAgIHNldFRleHQoJ21ldHJpYy1taW4tMjRoJywgbWV0cmljcyAmJiBtZXRyaWNzLm1pblBjdCAhPSBudWxsID8gZm9ybWF0UGVyY2VudCh0b051bWJlcihtZXRyaWNzLm1pblBjdCksIDIpIDogJ+KAlCcsIHsgY2hhbmdlQ2xhc3M6IHRydWUgfSk7CiAgICBzZXRUZXh0KCdtZXRyaWMtbWF4LTI0aCcsIG1ldHJpY3MgJiYgbWV0cmljcy5tYXhQY3QgIT0gbnVsbCA/IGZvcm1hdFBlcmNlbnQodG9OdW1iZXIobWV0cmljcy5tYXhQY3QpLCAyKSA6ICfigJQnLCB7IGNoYW5nZUNsYXNzOiB0cnVlIH0pOwogIH0KCiAgZnVuY3Rpb24gcm93SG91ckxhYmVsKGVwb2NoKSB7CiAgICBjb25zdCBuID0gdG9OdW1iZXIoZXBvY2gpOwogICAgaWYgKG4gPT09IG51bGwpIHJldHVybiAn4oCUJzsKICAgIHJldHVybiBmbXRBcmdIb3VyLmZvcm1hdChuZXcgRGF0ZShuICogMTAwMCkpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVySGlzdG9yeShwYXlsb2FkKSB7CiAgICBjb25zdCB0Ym9keSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoaXN0b3J5LXJvd3MnKTsKICAgIGNvbnN0IGNhcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoaXN0b3J5LWNhcCcpOwogICAgaWYgKCF0Ym9keSkgcmV0dXJuOwogICAgY29uc3QgZGF0YSA9IGV4dHJhY3RSb290KHBheWxvYWQpOwogICAgY29uc3QgaGlzdG9yeSA9IEFycmF5LmlzQXJyYXkoZGF0YS5oaXN0b3J5KSA/IGRhdGEuaGlzdG9yeS5zbGljZSgpIDogW107CiAgICBjb25zdCByb3dzID0gaGlzdG9yeS5zbGljZSgtSElTVE9SWV9ST1dTX0xJTUlUKS5yZXZlcnNlKCk7CiAgICBpZiAoY2FwKSBjYXAudGV4dENvbnRlbnQgPSBgw5psdGltYXMgJHtyb3dzLmxlbmd0aH0gbXVlc3RyYXNgOwogICAgaWYgKCFyb3dzLmxlbmd0aCkgewogICAgICB0Ym9keS5pbm5lckhUTUwgPSAnPHRyPjx0ZCBjbGFzcz0iZGltIiBjb2xzcGFuPSI2Ij5TaW4gcmVnaXN0cm9zIHRvZGF2w61hPC90ZD48L3RyPic7CiAgICAgIHJldHVybjsKICAgIH0KICAgIHRib2R5LmlubmVySFRNTCA9IHJvd3MubWFwKChyKSA9PiB7CiAgICAgIGNvbnN0IG1lcCA9IHRvTnVtYmVyKHIubWVwKTsKICAgICAgY29uc3QgY2NsID0gdG9OdW1iZXIoci5jY2wpOwogICAgICBjb25zdCBhYnMgPSB0b051bWJlcihyLmFic19kaWZmKTsKICAgICAgY29uc3QgcGN0ID0gdG9OdW1iZXIoci5wY3RfZGlmZik7CiAgICAgIGNvbnN0IHNpbSA9IEJvb2xlYW4oci5zaW1pbGFyKTsKICAgICAgcmV0dXJuIGA8dHI+CiAgICAgICAgPHRkIGNsYXNzPSJkaW0iPiR7cm93SG91ckxhYmVsKHIuZXBvY2gpfTwvdGQ+CiAgICAgICAgPHRkIHN0eWxlPSJjb2xvcjp2YXIoLS1tZXApIj4ke2Zvcm1hdE1vbmV5KG1lcCwgMil9PC90ZD4KICAgICAgICA8dGQgc3R5bGU9ImNvbG9yOnZhcigtLWNjbCkiPiR7Zm9ybWF0TW9uZXkoY2NsLCAyKX08L3RkPgogICAgICAgIDx0ZD4ke2Zvcm1hdE1vbmV5KGFicywgMil9PC90ZD4KICAgICAgICA8dGQ+JHtmb3JtYXRQZXJjZW50KHBjdCwgMil9PC90ZD4KICAgICAgICA8dGQ+PHNwYW4gY2xhc3M9InNiYWRnZSAke3NpbSA/ICdzaW0nIDogJ25vc2ltJ30iPiR7c2ltID8gJ1NpbWlsYXInIDogJ05vIHNpbWlsYXInfTwvc3Bhbj48L3RkPgogICAgICA8L3RyPmA7CiAgICB9KS5qb2luKCcnKTsKICB9CgogIGZ1bmN0aW9uIGxpbmVQb2ludHModmFsdWVzLCB4MCwgeDEsIHkwLCB5MSkgewogICAgaWYgKCF2YWx1ZXMubGVuZ3RoKSByZXR1cm4gJyc7CiAgICBjb25zdCBtaW4gPSBNYXRoLm1pbiguLi52YWx1ZXMpOwogICAgY29uc3QgbWF4ID0gTWF0aC5tYXgoLi4udmFsdWVzKTsKICAgIGNvbnN0IHNwYW4gPSBNYXRoLm1heCgwLjAwMDAwMSwgbWF4IC0gbWluKTsKICAgIHJldHVybiB2YWx1ZXMubWFwKCh2LCBpKSA9PiB7CiAgICAgIGNvbnN0IHggPSB4MCArICgoeDEgLSB4MCkgKiBpIC8gTWF0aC5tYXgoMSwgdmFsdWVzLmxlbmd0aCAtIDEpKTsKICAgICAgY29uc3QgeSA9IHkxIC0gKCh2IC0gbWluKSAvIHNwYW4pICogKHkxIC0geTApOwogICAgICByZXR1cm4gYCR7eC50b0ZpeGVkKDIpfSwke3kudG9GaXhlZCgyKX1gOwogICAgfSkuam9pbignICcpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyVHJlbmQocGF5bG9hZCkgewogICAgY29uc3QgZGF0YSA9IGV4dHJhY3RSb290KHBheWxvYWQpOwogICAgY29uc3QgaGlzdG9yeSA9IEFycmF5LmlzQXJyYXkoZGF0YS5oaXN0b3J5KSA/IGRhdGEuaGlzdG9yeS5zbGljZSgtVFJFTkRfUE9JTlRTKSA6IFtdOwogICAgY29uc3QgbWVwTGluZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1tZXAtbGluZScpOwogICAgY29uc3QgY2NsTGluZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1jY2wtbGluZScpOwogICAgY29uc3QgZ2FwTGluZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmVuZC1nYXAtbGluZScpOwogICAgaWYgKCFtZXBMaW5lIHx8ICFjY2xMaW5lIHx8ICFnYXBMaW5lKSByZXR1cm47CiAgICBpZiAoIWhpc3RvcnkubGVuZ3RoKSB7CiAgICAgIG1lcExpbmUuc2V0QXR0cmlidXRlKCdwb2ludHMnLCAnJyk7CiAgICAgIGNjbExpbmUuc2V0QXR0cmlidXRlKCdwb2ludHMnLCAnJyk7CiAgICAgIGdhcExpbmUuc2V0QXR0cmlidXRlKCdwb2ludHMnLCAnJyk7CiAgICAgIFsndHJlbmQteS10b3AnLCAndHJlbmQteS1taWQnLCAndHJlbmQteS1sb3cnLCAndHJlbmQteC0xJywgJ3RyZW5kLXgtMicsICd0cmVuZC14LTMnLCAndHJlbmQteC00JywgJ3RyZW5kLXgtNSddLmZvckVhY2goKGlkKSA9PiBzZXRUZXh0KGlkLCAn4oCUJykpOwogICAgICByZXR1cm47CiAgICB9CgogICAgY29uc3QgbWVwVmFscyA9IGhpc3RvcnkubWFwKChyKSA9PiB0b051bWJlcihyLm1lcCkpLmZpbHRlcigodikgPT4gdiAhPSBudWxsKTsKICAgIGNvbnN0IGNjbFZhbHMgPSBoaXN0b3J5Lm1hcCgocikgPT4gdG9OdW1iZXIoci5jY2wpKS5maWx0ZXIoKHYpID0+IHYgIT0gbnVsbCk7CiAgICBjb25zdCBnYXBWYWxzID0gaGlzdG9yeS5tYXAoKHIpID0+IHRvTnVtYmVyKHIucGN0X2RpZmYpKS5maWx0ZXIoKHYpID0+IHYgIT0gbnVsbCk7CiAgICBpZiAoIW1lcFZhbHMubGVuZ3RoIHx8ICFjY2xWYWxzLmxlbmd0aCkgcmV0dXJuOwoKICAgIG1lcExpbmUuc2V0QXR0cmlidXRlKCdwb2ludHMnLCBsaW5lUG9pbnRzKG1lcFZhbHMsIDMwLCA4NDAsIDI1LCAxMzApKTsKICAgIGNjbExpbmUuc2V0QXR0cmlidXRlKCdwb2ludHMnLCBsaW5lUG9pbnRzKGNjbFZhbHMsIDMwLCA4NDAsIDI1LCAxMzApKTsKICAgIGdhcExpbmUuc2V0QXR0cmlidXRlKCdwb2ludHMnLCBsaW5lUG9pbnRzKGdhcFZhbHMubGVuZ3RoID8gZ2FwVmFscyA6IFswXSwgMzAsIDg0MCwgMzUsIDYyKSk7CgogICAgY29uc3QgYWxsID0gbWVwVmFscy5jb25jYXQoY2NsVmFscyk7CiAgICBjb25zdCBtaW4gPSBNYXRoLm1pbiguLi5hbGwpOwogICAgY29uc3QgbWF4ID0gTWF0aC5tYXgoLi4uYWxsKTsKICAgIGNvbnN0IG1pZCA9IChtaW4gKyBtYXgpIC8gMjsKICAgIHNldFRleHQoJ3RyZW5kLXktdG9wJywgKG1heCAvIDEwMDApLnRvRml4ZWQoMykpOwogICAgc2V0VGV4dCgndHJlbmQteS1taWQnLCAobWlkIC8gMTAwMCkudG9GaXhlZCgzKSk7CiAgICBzZXRUZXh0KCd0cmVuZC15LWxvdycsIChtaW4gLyAxMDAwKS50b0ZpeGVkKDMpKTsKCiAgICBjb25zdCBpZHggPSBbMCwgMC4yNSwgMC41LCAwLjc1LCAxXS5tYXAoKHApID0+IE1hdGgubWluKGhpc3RvcnkubGVuZ3RoIC0gMSwgTWF0aC5mbG9vcigoaGlzdG9yeS5sZW5ndGggLSAxKSAqIHApKSk7CiAgICBjb25zdCBsYWJzID0gaWR4Lm1hcCgoaSkgPT4gcm93SG91ckxhYmVsKGhpc3RvcnlbaV0/LmVwb2NoKSk7CiAgICBzZXRUZXh0KCd0cmVuZC14LTEnLCBsYWJzWzBdIHx8ICfigJQnKTsKICAgIHNldFRleHQoJ3RyZW5kLXgtMicsIGxhYnNbMV0gfHwgJ+KAlCcpOwogICAgc2V0VGV4dCgndHJlbmQteC0zJywgbGFic1syXSB8fCAn4oCUJyk7CiAgICBzZXRUZXh0KCd0cmVuZC14LTQnLCBsYWJzWzNdIHx8ICfigJQnKTsKICAgIHNldFRleHQoJ3RyZW5kLXgtNScsIGxhYnNbNF0gfHwgJ+KAlCcpOwogIH0KCiAgLy8gNCkgRnVuY2nDs24gY2VudHJhbCBmZXRjaEFsbCgpCiAgYXN5bmMgZnVuY3Rpb24gZmV0Y2hKc29uKHVybCkgewogICAgY29uc3QgY3RybCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTsKICAgIGNvbnN0IHRpbWVvdXQgPSBzZXRUaW1lb3V0KCgpID0+IGN0cmwuYWJvcnQoKSwgMTIwMDApOwogICAgdHJ5IHsKICAgICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2godXJsLCB7IGNhY2hlOiAnbm8tc3RvcmUnLCBzaWduYWw6IGN0cmwuc2lnbmFsIH0pOwogICAgICBpZiAoIXJlcy5vaykgdGhyb3cgbmV3IEVycm9yKGBIVFRQICR7cmVzLnN0YXR1c31gKTsKICAgICAgcmV0dXJuIGF3YWl0IHJlcy5qc29uKCk7CiAgICB9IGZpbmFsbHkgewogICAgICBjbGVhclRpbWVvdXQodGltZW91dCk7CiAgICB9CiAgfQoKICBhc3luYyBmdW5jdGlvbiBmZXRjaEFsbChvcHRpb25zID0ge30pIHsKICAgIGlmIChzdGF0ZS5pc0ZldGNoaW5nKSByZXR1cm47CiAgICBzdGF0ZS5pc0ZldGNoaW5nID0gdHJ1ZTsKICAgIHNldExvYWRpbmcoTlVNRVJJQ19JRFMsIHRydWUpOwogICAgc2V0RnJlc2hCYWRnZSgnQWN0dWFsaXphbmRv4oCmJywgJ2ZldGNoaW5nJyk7CiAgICBzZXRFcnJvckJhbm5lcihmYWxzZSk7CiAgICB0cnkgewogICAgICBjb25zdCB0YXNrcyA9IFsKICAgICAgICBbJ21lcENjbCcsIEVORFBPSU5UUy5tZXBDY2xdLAogICAgICAgIFsnZXh0cmFzJywgRU5EUE9JTlRTLmV4dHJhc10KICAgICAgXTsKCiAgICAgIGNvbnN0IHNldHRsZWQgPSBhd2FpdCBQcm9taXNlLmFsbFNldHRsZWQodGFza3MubWFwKGFzeW5jIChbbmFtZSwgdXJsXSkgPT4gewogICAgICAgIHRyeSB7CiAgICAgICAgICBjb25zdCBkYXRhID0gYXdhaXQgZmV0Y2hKc29uKHVybCk7CiAgICAgICAgICByZXR1cm4geyBuYW1lLCBkYXRhIH07CiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHsKICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYFtSYWRhck1FUF0gZXJyb3IgZW4gJHtuYW1lfWAsIGVycm9yKTsKICAgICAgICAgIHRocm93IHsgbmFtZSwgZXJyb3IgfTsKICAgICAgICB9CiAgICAgIH0pKTsKCiAgICAgIGNvbnN0IGJhZyA9IHsgdGltZXN0YW1wOiBEYXRlLm5vdygpLCBtZXBDY2w6IG51bGwsIGV4dHJhczogbnVsbCB9OwogICAgICBjb25zdCBmYWlsZWQgPSBbXTsKICAgICAgc2V0dGxlZC5mb3JFYWNoKChyLCBpZHgpID0+IHsKICAgICAgICBjb25zdCBuYW1lID0gdGFza3NbaWR4XVswXTsKICAgICAgICBpZiAoci5zdGF0dXMgPT09ICdmdWxmaWxsZWQnKSBiYWdbbmFtZV0gPSByLnZhbHVlLmRhdGE7CiAgICAgICAgZWxzZSBmYWlsZWQucHVzaChuYW1lKTsKICAgICAgfSk7CgogICAgICByZW5kZXJNZXBDY2woYmFnLm1lcENjbCk7CiAgICAgIHJlbmRlck1ldHJpY3MyNGgoYmFnLm1lcENjbCk7CiAgICAgIHJlbmRlclRyZW5kKGJhZy5tZXBDY2wpOwogICAgICByZW5kZXJIaXN0b3J5KGJhZy5tZXBDY2wpOwogICAgICBjb25zdCBleHRyYXNSb290ID0gZXh0cmFjdFJvb3QoYmFnLmV4dHJhcyk7CiAgICAgIHJlbmRlckNhdWNpb25lcyhleHRyYXNSb290Py5jYXVjaW9uZXMgfHwgbnVsbCk7CiAgICAgIHJlbmRlckJvbm9zKGV4dHJhc1Jvb3Q/LmJvbm9zIHx8IG51bGwpOwogICAgICByZW5kZXJMZXRyYXMoZXh0cmFzUm9vdD8ubGV0cmFzIHx8IG51bGwpOwogICAgICByZW5kZXJDb250ZXh0Qm94KCk7CiAgICAgIGNvbnN0IG1lcFJvb3QgPSBleHRyYWN0Um9vdChiYWcubWVwQ2NsKTsKICAgICAgY29uc3QgdXBkYXRlZEFydCA9IHR5cGVvZiBtZXBSb290Py51cGRhdGVkQXRIdW1hbkFydCA9PT0gJ3N0cmluZycgPyBtZXBSb290LnVwZGF0ZWRBdEh1bWFuQXJ0IDogbnVsbDsKICAgICAgY29uc3Qgc291cmNlRnJlc2ggPSB0eXBlb2YgbWVwUm9vdD8uc291cmNlU3RhdHVzPy5mcmVzaExhYmVsID09PSAnc3RyaW5nJyA/IG1lcFJvb3Quc291cmNlU3RhdHVzLmZyZXNoTGFiZWwgOiBudWxsOwogICAgICBzZXRUZXh0KCdsYXN0LXJ1bi10aW1lJywgdXBkYXRlZEFydCB8fCBmbXRBcmdUaW1lU2VjLmZvcm1hdChuZXcgRGF0ZSgpKSk7CgogICAgICBjb25zdCBzdWNjZXNzQ291bnQgPSB0YXNrcy5sZW5ndGggLSBmYWlsZWQubGVuZ3RoOwogICAgICBpZiAoc3VjY2Vzc0NvdW50ID4gMCkgewogICAgICAgIHN0YXRlLmxhc3RTdWNjZXNzQXQgPSBEYXRlLm5vdygpOwogICAgICAgIHN0YXRlLnJldHJ5SW5kZXggPSAwOwogICAgICAgIGlmIChzdGF0ZS5yZXRyeVRpbWVyKSBjbGVhclRpbWVvdXQoc3RhdGUucmV0cnlUaW1lcik7CiAgICAgICAgc2F2ZUNhY2hlKGJhZyk7CiAgICAgICAgY29uc3QgYmFkZ2VCYXNlID0gc291cmNlRnJlc2ggPyBgRnVlbnRlICR7c291cmNlRnJlc2h9YCA6IGBBY3R1YWxpemFkbyDCtyAke2ZtdEFyZ1RpbWUuZm9ybWF0KG5ldyBEYXRlKCkpfWA7CiAgICAgICAgaWYgKGZhaWxlZC5sZW5ndGgpIHNldEZyZXNoQmFkZ2UoYEFjdHVhbGl6YWNpw7NuIHBhcmNpYWwgwrcgJHtiYWRnZUJhc2V9YCwgJ2lkbGUnKTsKICAgICAgICBlbHNlIHNldEZyZXNoQmFkZ2UoYmFkZ2VCYXNlLCAnaWRsZScpOwogICAgICB9IGVsc2UgewogICAgICAgIGNvbnN0IGF0dGVtcHQgPSBzdGF0ZS5yZXRyeUluZGV4ICsgMTsKICAgICAgICBpZiAoc3RhdGUucmV0cnlJbmRleCA8IFJFVFJZX0RFTEFZUy5sZW5ndGgpIHsKICAgICAgICAgIGNvbnN0IGRlbGF5ID0gUkVUUllfREVMQVlTW3N0YXRlLnJldHJ5SW5kZXhdOwogICAgICAgICAgc3RhdGUucmV0cnlJbmRleCArPSAxOwogICAgICAgICAgc2V0RnJlc2hCYWRnZShgRXJyb3IgwrcgUmVpbnRlbnRvIGVuICR7TWF0aC5yb3VuZChkZWxheSAvIDEwMDApfXNgLCAnZXJyb3InKTsKICAgICAgICAgIGlmIChzdGF0ZS5yZXRyeVRpbWVyKSBjbGVhclRpbWVvdXQoc3RhdGUucmV0cnlUaW1lcik7CiAgICAgICAgICBzdGF0ZS5yZXRyeVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBmZXRjaEFsbCh7IG1hbnVhbDogdHJ1ZSB9KSwgZGVsYXkpOwogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICBzZXRGcmVzaEJhZGdlKCdFcnJvciDCtyBSZWludGVudGFyJywgJ2Vycm9yJyk7CiAgICAgICAgICBzZXRFcnJvckJhbm5lcih0cnVlLCAnRXJyb3IgYWwgYWN0dWFsaXphciDCtyBSZWludGVudGFyJyk7CiAgICAgICAgICBjb25zb2xlLmVycm9yKGBbUmFkYXJNRVBdIHNlIGFnb3Rhcm9uIHJldHJpZXMgKCR7YXR0ZW1wdH0gaW50ZW50b3MpYCk7CiAgICAgICAgICBpZiAod2luZG93LnNjaGVkdWxlcikgd2luZG93LnNjaGVkdWxlci5zdG9wKCk7CiAgICAgICAgfQogICAgICB9CiAgICB9IGZpbmFsbHkgewogICAgICBzZXRMb2FkaW5nKE5VTUVSSUNfSURTLCBmYWxzZSk7CiAgICAgIHN0YXRlLmlzRmV0Y2hpbmcgPSBmYWxzZTsKICAgIH0KICB9CgogIC8vIDUpIENsYXNlIE1hcmtldFNjaGVkdWxlcgogIGNsYXNzIE1hcmtldFNjaGVkdWxlciB7CiAgICBjb25zdHJ1Y3RvcihmZXRjaEZuLCBpbnRlcnZhbE1zID0gMzAwMDAwKSB7CiAgICAgIHRoaXMuZmV0Y2hGbiA9IGZldGNoRm47CiAgICAgIHRoaXMuaW50ZXJ2YWxNcyA9IGludGVydmFsTXM7CiAgICAgIHRoaXMudGltZXIgPSBudWxsOwogICAgICB0aGlzLndhaXRUaW1lciA9IG51bGw7CiAgICAgIHRoaXMuY291bnRkb3duVGltZXIgPSBudWxsOwogICAgICB0aGlzLm5leHRSdW5BdCA9IG51bGw7CiAgICAgIHRoaXMucnVubmluZyA9IGZhbHNlOwogICAgICB0aGlzLnBhdXNlZCA9IGZhbHNlOwogICAgfQoKICAgIHN0YXJ0KCkgewogICAgICBpZiAodGhpcy5ydW5uaW5nKSByZXR1cm47CiAgICAgIHRoaXMucnVubmluZyA9IHRydWU7CiAgICAgIHRoaXMucGF1c2VkID0gZmFsc2U7CiAgICAgIGlmICh0aGlzLmlzTWFya2V0T3BlbigpKSB7CiAgICAgICAgc2V0TWFya2V0VGFnKHRydWUpOwogICAgICAgIHRoaXMuX3NjaGVkdWxlKHRoaXMuaW50ZXJ2YWxNcyk7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgc2V0TWFya2V0VGFnKGZhbHNlKTsKICAgICAgICB0aGlzLl93YWl0Rm9yT3BlbigpOwogICAgICB9CiAgICAgIHRoaXMuX3N0YXJ0Q291bnRkb3duKCk7CiAgICB9CgogICAgcGF1c2UoKSB7CiAgICAgIHRoaXMucGF1c2VkID0gdHJ1ZTsKICAgICAgY2xlYXJUaW1lb3V0KHRoaXMudGltZXIpOwogICAgICBjbGVhclRpbWVvdXQodGhpcy53YWl0VGltZXIpOwogICAgICB0aGlzLnRpbWVyID0gbnVsbDsKICAgICAgdGhpcy53YWl0VGltZXIgPSBudWxsOwogICAgICB0aGlzLl9zdG9wQ291bnRkb3duKCk7CiAgICAgIGNvbnN0IGNvdW50ZG93biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb3VudGRvd24tdGV4dCcpOwogICAgICBpZiAoY291bnRkb3duKSBjb3VudGRvd24udGV4dENvbnRlbnQgPSAnQWN0dWFsaXphY2nDs24gcGF1c2FkYSc7CiAgICB9CgogICAgcmVzdW1lKCkgewogICAgICBpZiAoIXRoaXMucnVubmluZykgdGhpcy5ydW5uaW5nID0gdHJ1ZTsKICAgICAgdGhpcy5wYXVzZWQgPSBmYWxzZTsKICAgICAgY29uc3QgY29udGludWVSZXN1bWUgPSAoKSA9PiB7CiAgICAgICAgaWYgKHRoaXMuaXNNYXJrZXRPcGVuKCkpIHsKICAgICAgICAgIHNldE1hcmtldFRhZyh0cnVlKTsKICAgICAgICAgIHRoaXMuX3NjaGVkdWxlKHRoaXMuaW50ZXJ2YWxNcyk7CiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgIHNldE1hcmtldFRhZyhmYWxzZSk7CiAgICAgICAgICB0aGlzLl93YWl0Rm9yT3BlbigpOwogICAgICAgIH0KICAgICAgICB0aGlzLl9zdGFydENvdW50ZG93bigpOwogICAgICB9OwogICAgICBpZiAoRGF0ZS5ub3coKSAtIHN0YXRlLmxhc3RTdWNjZXNzQXQgPiB0aGlzLmludGVydmFsTXMpIHsKICAgICAgICBQcm9taXNlLnJlc29sdmUodGhpcy5mZXRjaEZuKHsgbWFudWFsOiB0cnVlIH0pKS5maW5hbGx5KGNvbnRpbnVlUmVzdW1lKTsKICAgICAgfSBlbHNlIHsKICAgICAgICBjb250aW51ZVJlc3VtZSgpOwogICAgICB9CiAgICB9CgogICAgc3RvcCgpIHsKICAgICAgdGhpcy5ydW5uaW5nID0gZmFsc2U7CiAgICAgIHRoaXMucGF1c2VkID0gZmFsc2U7CiAgICAgIGNsZWFyVGltZW91dCh0aGlzLnRpbWVyKTsKICAgICAgY2xlYXJUaW1lb3V0KHRoaXMud2FpdFRpbWVyKTsKICAgICAgdGhpcy50aW1lciA9IG51bGw7CiAgICAgIHRoaXMud2FpdFRpbWVyID0gbnVsbDsKICAgICAgdGhpcy5uZXh0UnVuQXQgPSBudWxsOwogICAgICB0aGlzLl9zdG9wQ291bnRkb3duKCk7CiAgICB9CgogICAgaXNNYXJrZXRPcGVuKCkgewogICAgICBjb25zdCBwID0gZ2V0QXJnTm93UGFydHMoKTsKICAgICAgY29uc3QgYnVzaW5lc3NEYXkgPSBwLndlZWtkYXkgPj0gMSAmJiBwLndlZWtkYXkgPD0gNTsKICAgICAgY29uc3Qgc2Vjb25kcyA9IHAuaG91ciAqIDM2MDAgKyBwLm1pbnV0ZSAqIDYwICsgcC5zZWNvbmQ7CiAgICAgIGNvbnN0IGZyb20gPSAxMCAqIDM2MDAgKyAzMCAqIDYwOwogICAgICBjb25zdCB0byA9IDE4ICogMzYwMDsKICAgICAgcmV0dXJuIGJ1c2luZXNzRGF5ICYmIHNlY29uZHMgPj0gZnJvbSAmJiBzZWNvbmRzIDwgdG87CiAgICB9CgogICAgZ2V0TmV4dFJ1blRpbWUoKSB7CiAgICAgIHJldHVybiB0aGlzLm5leHRSdW5BdCA/IG5ldyBEYXRlKHRoaXMubmV4dFJ1bkF0KSA6IG51bGw7CiAgICB9CgogICAgX3NjaGVkdWxlKGRlbGF5TXMpIHsKICAgICAgaWYgKCF0aGlzLnJ1bm5pbmcgfHwgdGhpcy5wYXVzZWQpIHJldHVybjsKICAgICAgY2xlYXJUaW1lb3V0KHRoaXMudGltZXIpOwogICAgICB0aGlzLm5leHRSdW5BdCA9IERhdGUubm93KCkgKyBkZWxheU1zOwogICAgICB0aGlzLnRpbWVyID0gc2V0VGltZW91dChhc3luYyAoKSA9PiB7CiAgICAgICAgaWYgKCF0aGlzLnJ1bm5pbmcgfHwgdGhpcy5wYXVzZWQpIHJldHVybjsKICAgICAgICBpZiAoIXRoaXMuaXNNYXJrZXRPcGVuKCkpIHsKICAgICAgICAgIHNldE1hcmtldFRhZyhmYWxzZSk7CiAgICAgICAgICB0aGlzLl93YWl0Rm9yT3BlbigpOwogICAgICAgICAgcmV0dXJuOwogICAgICAgIH0KICAgICAgICBzZXRNYXJrZXRUYWcodHJ1ZSk7CiAgICAgICAgYXdhaXQgdGhpcy5mZXRjaEZuKCk7CiAgICAgICAgdGhpcy5fc2NoZWR1bGUodGhpcy5pbnRlcnZhbE1zKTsKICAgICAgfSwgZGVsYXlNcyk7CiAgICB9CgogICAgX3dhaXRGb3JPcGVuKCkgewogICAgICBpZiAoIXRoaXMucnVubmluZyB8fCB0aGlzLnBhdXNlZCkgcmV0dXJuOwogICAgICBjbGVhclRpbWVvdXQodGhpcy53YWl0VGltZXIpOwogICAgICB0aGlzLm5leHRSdW5BdCA9IERhdGUubm93KCkgKyA2MDAwMDsKICAgICAgdGhpcy53YWl0VGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHsKICAgICAgICBpZiAoIXRoaXMucnVubmluZyB8fCB0aGlzLnBhdXNlZCkgcmV0dXJuOwogICAgICAgIGlmICh0aGlzLmlzTWFya2V0T3BlbigpKSB7CiAgICAgICAgICBzZXRNYXJrZXRUYWcodHJ1ZSk7CiAgICAgICAgICB0aGlzLmZldGNoRm4oeyBtYW51YWw6IHRydWUgfSk7CiAgICAgICAgICB0aGlzLl9zY2hlZHVsZSh0aGlzLmludGVydmFsTXMpOwogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICBzZXRNYXJrZXRUYWcoZmFsc2UpOwogICAgICAgICAgdGhpcy5fd2FpdEZvck9wZW4oKTsKICAgICAgICB9CiAgICAgIH0sIDYwMDAwKTsKICAgIH0KCiAgICBfc3RhcnRDb3VudGRvd24oKSB7CiAgICAgIHRoaXMuX3N0b3BDb3VudGRvd24oKTsKICAgICAgdGhpcy5jb3VudGRvd25UaW1lciA9IHNldEludGVydmFsKCgpID0+IHsKICAgICAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb3VudGRvd24tdGV4dCcpOwogICAgICAgIGlmICghZWwgfHwgdGhpcy5wYXVzZWQpIHJldHVybjsKICAgICAgICBjb25zdCBuZXh0ID0gdGhpcy5nZXROZXh0UnVuVGltZSgpOwogICAgICAgIGlmICghbmV4dCkgewogICAgICAgICAgZWwudGV4dENvbnRlbnQgPSB0aGlzLmlzTWFya2V0T3BlbigpID8gJ1Byw7N4aW1hIGFjdHVhbGl6YWNpw7NuIGVuIOKAlCcgOiAnTWVyY2FkbyBjZXJyYWRvJzsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgICAgY29uc3QgZGlmZiA9IE1hdGgubWF4KDAsIG5leHQuZ2V0VGltZSgpIC0gRGF0ZS5ub3coKSk7CiAgICAgICAgY29uc3QgbSA9IE1hdGguZmxvb3IoZGlmZiAvIDYwMDAwKTsKICAgICAgICBjb25zdCBzID0gTWF0aC5mbG9vcigoZGlmZiAlIDYwMDAwKSAvIDEwMDApOwogICAgICAgIGlmICh0aGlzLmlzTWFya2V0T3BlbigpKSBlbC50ZXh0Q29udGVudCA9IGBQcsOzeGltYSBhY3R1YWxpemFjacOzbiBlbiAke219OiR7U3RyaW5nKHMpLnBhZFN0YXJ0KDIsICcwJyl9YDsKICAgICAgICBlbHNlIGVsLnRleHRDb250ZW50ID0gJ01lcmNhZG8gY2VycmFkbyc7CiAgICAgIH0sIDEwMDApOwogICAgfQoKICAgIF9zdG9wQ291bnRkb3duKCkgewogICAgICBjbGVhckludGVydmFsKHRoaXMuY291bnRkb3duVGltZXIpOwogICAgICB0aGlzLmNvdW50ZG93blRpbWVyID0gbnVsbDsKICAgIH0KICB9CgogIC8vIDYpIEzDs2dpY2EgZGUgY2FjaMOpCiAgZnVuY3Rpb24gc2F2ZUNhY2hlKGRhdGEpIHsKICAgIHRyeSB7CiAgICAgIHNlc3Npb25TdG9yYWdlLnNldEl0ZW0oQ0FDSEVfS0VZLCBKU09OLnN0cmluZ2lmeSh7CiAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLAogICAgICAgIG1lcENjbDogZGF0YS5tZXBDY2wsCiAgICAgICAgZXh0cmFzOiBkYXRhLmV4dHJhcwogICAgICB9KSk7CiAgICB9IGNhdGNoIChlKSB7CiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tSYWRhck1FUF0gbm8gc2UgcHVkbyBndWFyZGFyIGNhY2hlJywgZSk7CiAgICB9CiAgfQoKICBmdW5jdGlvbiBsb2FkQ2FjaGUoKSB7CiAgICB0cnkgewogICAgICBjb25zdCByYXcgPSBzZXNzaW9uU3RvcmFnZS5nZXRJdGVtKENBQ0hFX0tFWSk7CiAgICAgIGlmICghcmF3KSByZXR1cm4gbnVsbDsKICAgICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyYXcpOwogICAgICBpZiAoIXBhcnNlZC50aW1lc3RhbXAgfHwgRGF0ZS5ub3coKSAtIHBhcnNlZC50aW1lc3RhbXAgPiBDQUNIRV9UVExfTVMpIHJldHVybiBudWxsOwogICAgICByZXR1cm4gcGFyc2VkOwogICAgfSBjYXRjaCAoZSkgewogICAgICBjb25zb2xlLmVycm9yKCdbUmFkYXJNRVBdIGNhY2hlIGludsOhbGlkYScsIGUpOwogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICB9CgogIC8vIDcpIEluaWNpYWxpemFjacOzbgogIGZ1bmN0aW9uIHRvZ2dsZURyYXdlcigpIHsKICAgIGNvbnN0IGRyYXdlciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdkcmF3ZXInKTsKICAgIGNvbnN0IHdyYXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYm9keVdyYXAnKTsKICAgIGNvbnN0IGJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdidG5UYXNhcycpOwogICAgY29uc3Qgb3ZsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ292ZXJsYXknKTsKICAgIGNvbnN0IGlzT3BlbiA9IGRyYXdlci5jbGFzc0xpc3QuY29udGFpbnMoJ29wZW4nKTsKICAgIGRyYXdlci5jbGFzc0xpc3QudG9nZ2xlKCdvcGVuJywgIWlzT3Blbik7CiAgICB3cmFwLmNsYXNzTGlzdC50b2dnbGUoJ2RyYXdlci1vcGVuJywgIWlzT3Blbik7CiAgICBidG4uY2xhc3NMaXN0LnRvZ2dsZSgnYWN0aXZlJywgIWlzT3Blbik7CiAgICBvdmwuY2xhc3NMaXN0LnRvZ2dsZSgnc2hvdycsICFpc09wZW4pOwogIH0KCiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnBpbGwnKS5mb3JFYWNoKChwKSA9PiB7CiAgICBwLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gewogICAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcucGlsbCcpLmZvckVhY2goKHgpID0+IHguY2xhc3NMaXN0LnJlbW92ZSgnb24nKSk7CiAgICAgIHAuY2xhc3NMaXN0LmFkZCgnb24nKTsKICAgIH0pOwogIH0pOwoKICBmdW5jdGlvbiB0b2dnbGVHbG9zKCkgewogICAgY29uc3QgZ3JpZCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdnbG9zR3JpZCcpOwogICAgY29uc3QgYXJyb3cgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZ2xvc0Fycm93Jyk7CiAgICBjb25zdCBvcGVuID0gZ3JpZC5jbGFzc0xpc3QudG9nZ2xlKCdvcGVuJyk7CiAgICBhcnJvdy50ZXh0Q29udGVudCA9IG9wZW4gPyAn4pa0JyA6ICfilr4nOwogIH0KCiAgY29uc3QgcmV0cnlCdG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZXJyb3ItcmV0cnktYnRuJyk7CiAgaWYgKHJldHJ5QnRuKSB7CiAgICByZXRyeUJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgICAgaWYgKHdpbmRvdy5zY2hlZHVsZXIpIHdpbmRvdy5zY2hlZHVsZXIucmVzdW1lKCk7CiAgICAgIGZldGNoQWxsKHsgbWFudWFsOiB0cnVlIH0pOwogICAgfSk7CiAgfQoKICBjb25zdCBjYWNoZWQgPSBsb2FkQ2FjaGUoKTsKICBpZiAoY2FjaGVkKSB7CiAgICByZW5kZXJNZXBDY2woY2FjaGVkLm1lcENjbCk7CiAgICByZW5kZXJNZXRyaWNzMjRoKGNhY2hlZC5tZXBDY2wpOwogICAgcmVuZGVyVHJlbmQoY2FjaGVkLm1lcENjbCk7CiAgICByZW5kZXJIaXN0b3J5KGNhY2hlZC5tZXBDY2wpOwogICAgY29uc3QgY2FjaGVkRXh0cmFzID0gZXh0cmFjdFJvb3QoY2FjaGVkLmV4dHJhcyk7CiAgICByZW5kZXJDYXVjaW9uZXMoY2FjaGVkRXh0cmFzPy5jYXVjaW9uZXMgfHwgbnVsbCk7CiAgICByZW5kZXJCb25vcyhjYWNoZWRFeHRyYXM/LmJvbm9zIHx8IG51bGwpOwogICAgcmVuZGVyTGV0cmFzKGNhY2hlZEV4dHJhcz8ubGV0cmFzIHx8IG51bGwpOwogICAgcmVuZGVyQ29udGV4dEJveCgpOwogICAgc2V0RnJlc2hCYWRnZShgRGF0byBlbiBjYWNow6kgwrcgJHtmbXRBcmdUaW1lLmZvcm1hdChuZXcgRGF0ZShjYWNoZWQudGltZXN0YW1wKSl9YCwgJ2lkbGUnKTsKICB9CgogIHdpbmRvdy5zY2hlZHVsZXIgPSBuZXcgTWFya2V0U2NoZWR1bGVyKGZldGNoQWxsLCBGRVRDSF9JTlRFUlZBTF9NUyk7CiAgd2luZG93LnNjaGVkdWxlci5zdGFydCgpOwogIGZldGNoQWxsKHsgbWFudWFsOiB0cnVlIH0pOwoKICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCd2aXNpYmlsaXR5Y2hhbmdlJywgKCkgPT4gewogICAgaWYgKGRvY3VtZW50LmhpZGRlbikgd2luZG93LnNjaGVkdWxlci5wYXVzZSgpOwogICAgZWxzZSB3aW5kb3cuc2NoZWR1bGVyLnJlc3VtZSgpOwogIH0pOwo8L3NjcmlwdD4KPC9ib2R5Pgo8L2h0bWw+Cg==`;

function decodeBase64Utf8(b64) {
  const compact = b64.replace(/\s+/g, "");
  const binary = atob(compact);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function renderDashboardHtml() {
  return decodeBase64Utf8(DASHBOARD_HTML_B64);
}
