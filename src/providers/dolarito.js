import { ProviderDataError, toProviderDataError } from "./errors.js";
import { validateDolaritoParsedPayload } from "./schemas.js";

function extractNumber(html, key, field) {
  const re = new RegExp(
    String.raw`\\?"${key}\\?":\s*\\?\{[\s\S]*?\\?"${field}\\?":\s*([0-9]+(?:\.[0-9]+)?)`,
    "i",
  );
  const match = html.match(re);
  return match ? Number(match[1]) : Number.NaN;
}

function extractTimestampMs(html, key, field) {
  const re = new RegExp(
    String.raw`\\?"${key}\\?":\s*\\?\{[\s\S]*?\\?"${field}\\?":\s*([0-9]{10,})`,
    "i",
  );
  const match = html.match(re);
  return match ? Number(match[1]) : null;
}

export function parseDolaritoHtml(html, provider = "dolarito") {
  try {
    if (typeof html !== "string" || !html.trim()) {
      throw new ProviderDataError({
        provider,
        errorType: "parse",
        message: "Dolarito HTML payload is empty",
      });
    }

    const parsed = {
      mepSell: extractNumber(html, "mep", "sell"),
      cclSell: extractNumber(html, "ccl", "sell"),
      mepTimestampMs: extractTimestampMs(html, "mep", "timestamp"),
      cclTimestampMs: extractTimestampMs(html, "ccl", "timestamp"),
    };

    if (!Number.isFinite(parsed.mepSell) || !Number.isFinite(parsed.cclSell)) {
      throw new ProviderDataError({
        provider,
        errorType: "parse",
        message: "Unable to parse mep/ccl sell values from HTML",
      });
    }

    return validateDolaritoParsedPayload(parsed, provider);
  } catch (error) {
    if (error instanceof ProviderDataError) throw error;
    throw toProviderDataError(error, { provider, errorType: "unknown" });
  }
}
