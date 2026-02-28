const WEEKDAY_MAP = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatterCache = new Map();

function getFormatter(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(
      timeZone,
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }),
    );
  }
  return formatterCache.get(timeZone);
}

function getTimePartsInZone(date, timeZone) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const formatter = getFormatter(timeZone);
  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  const weekday = WEEKDAY_MAP[parts.weekday];
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  if (!Number.isInteger(weekday) || !Number.isFinite(hour) || !Number.isFinite(minute) || !Number.isFinite(second)) {
    return null;
  }
  return { weekday, hour, minute, second };
}

function parseHourMinute(value) {
  const match = String(value).trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60;
}

function asFiniteNumber(value) {
  return Number.isFinite(value) ? value : Number.NaN;
}

export function calcSpreadAbs(mep, ccl) {
  const safeMep = asFiniteNumber(mep);
  const safeCcl = asFiniteNumber(ccl);
  if (!Number.isFinite(safeMep) || !Number.isFinite(safeCcl)) return Number.NaN;
  return Math.abs(safeMep - safeCcl);
}

export function calcSpreadPctRatio(mep, ccl) {
  const safeMep = asFiniteNumber(mep);
  const safeCcl = asFiniteNumber(ccl);
  if (!Number.isFinite(safeMep) || !Number.isFinite(safeCcl)) return Number.NaN;
  const avg = (safeMep + safeCcl) / 2;
  if (!(avg > 0)) return Number.NaN;
  return Math.abs(safeMep - safeCcl) / avg;
}

export function toPercent(ratio) {
  const safeRatio = asFiniteNumber(ratio);
  if (!Number.isFinite(safeRatio)) return Number.NaN;
  return safeRatio * 100;
}

export function isSimilar(mep, ccl, { pctThreshold = 0.01, absThreshold = 10 } = {}) {
  const spreadAbs = calcSpreadAbs(mep, ccl);
  const spreadPctRatio = calcSpreadPctRatio(mep, ccl);
  const withinAbs = Number.isFinite(spreadAbs) && spreadAbs <= absThreshold;
  const withinPct = Number.isFinite(spreadPctRatio) && spreadPctRatio <= pctThreshold;
  return withinAbs || withinPct;
}

export function calcStalenessSeconds(now, lastTimestamp) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return null;
  if (!(lastTimestamp instanceof Date) || Number.isNaN(lastTimestamp.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - lastTimestamp.getTime()) / 1000));
}

export function isMarketOpen(
  now,
  timezone = "America/Argentina/Buenos_Aires",
  open = "10:30",
  close = "18:00",
  weekdaysOnly = true,
) {
  const parts = getTimePartsInZone(now, timezone);
  if (!parts) return false;
  if (weekdaysOnly && (parts.weekday === 0 || parts.weekday === 6)) return false;

  const openSeconds = parseHourMinute(open);
  const closeSeconds = parseHourMinute(close);
  if (!Number.isFinite(openSeconds) || !Number.isFinite(closeSeconds) || closeSeconds <= openSeconds) return false;

  const nowSeconds = parts.hour * 3600 + parts.minute * 60 + parts.second;
  return nowSeconds >= openSeconds && nowSeconds < closeSeconds;
}
