#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

SIMILARITY_MAX_DIFF_ARS="${SIMILARITY_MAX_DIFF_ARS:-12}"
SIMILARITY_MAX_DIFF_PERCENT="${SIMILARITY_MAX_DIFF_PERCENT:-1.0}"
ALERT_COOLDOWN_MINUTES="${ALERT_COOLDOWN_MINUTES:-120}"
STATE_FILE="${STATE_FILE:-$SCRIPT_DIR/.dolar_monitor_state}"
HISTORY_LOG="${HISTORY_LOG:-$SCRIPT_DIR/.dolar_history.log}"
HISTORY_MAX_ITEMS="${HISTORY_MAX_ITEMS:-200}"
SOURCE_URL="${SOURCE_URL:-https://www.dolarito.ar/cotizacion/dolar-hoy}"
OUTPUT_HTML="${OUTPUT_HTML:-$SCRIPT_DIR/public/dashboard.html}"
SMTP_PORT="${SMTP_PORT:-587}"
SMTP_USE_TLS="${SMTP_USE_TLS:-true}"

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

mkdir -p "$(dirname "$OUTPUT_HTML")"

extract_sell() {
  local key="$1"
  perl -0777 -ne 'if (/\\?"'"$key"'\\?":\{.*?\\?"sell\\?":([0-9]+(?:\.[0-9]+)?)/s) { print $1; exit 0 } else { exit 1 }' <<<"$HTML"
}

extract_ts() {
  local key="$1"
  perl -0777 -ne 'if (/\\?"'"$key"'\\?":\{.*?\\?"timestamp\\?":([0-9]+)/s) { print $1; exit 0 } else { exit 1 }' <<<"$HTML" || true
}

is_number() {
  [[ "$1" =~ ^[0-9]+([.][0-9]+)?$ ]]
}

format_ts() {
  local ts="$1"
  if [[ -z "$ts" ]]; then
    echo "s/dato"
  else
    date -r "$((ts/1000))" "+%Y-%m-%d %H:%M:%S %Z" 2>/dev/null || echo "$ts"
  fi
}

MARKET_STATUS="CERRADO"
MARKET_COLOR="#7c3f00"
ARG_WEEKDAY="$(TZ=America/Argentina/Buenos_Aires date +%u)"
ARG_HHMM="$(TZ=America/Argentina/Buenos_Aires date +%H%M)"
if [[ "$ARG_WEEKDAY" -ge 1 && "$ARG_WEEKDAY" -le 5 && "$ARG_HHMM" -ge 1100 && "$ARG_HHMM" -lt 1800 ]]; then
  MARKET_STATUS="ABIERTO"
  MARKET_COLOR="#0f7a36"
fi

NOW_HUMAN="$(date '+%Y-%m-%d %H:%M:%S %Z')"
NOW_EPOCH="$(date +%s)"

SCRAPE_OK=0
SCRAPE_ERROR=""
SOURCE_STATUS_TEXT="OK"
SOURCE_STATUS_COLOR="#0f7a36"

HTML=""
if ! HTML="$(curl -sL --retry 3 --retry-delay 2 --max-time 25 \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36' \
  -H 'Accept-Language: es-AR,es;q=0.9,en;q=0.8' \
  "$SOURCE_URL")"; then
  SCRAPE_ERROR="No se pudo consultar la fuente de datos."
fi

MEP=""
CCL=""
MEP_TS=""
CCL_TS=""
ABS_DIFF="0.00"
PCT_DIFF="0.00"
SIMILAR="0"

if [[ -z "$SCRAPE_ERROR" ]]; then
  MEP="$(extract_sell "mep" || true)"
  CCL="$(extract_sell "ccl" || true)"
  MEP_TS="$(extract_ts "mep" || true)"
  CCL_TS="$(extract_ts "ccl" || true)"
  if ! is_number "$MEP" || ! is_number "$CCL"; then
    SCRAPE_ERROR="No se pudo parsear MEP/CCL desde la fuente."
  fi
fi

if [[ -z "$SCRAPE_ERROR" ]]; then
  SCRAPE_OK=1
  read -r ABS_DIFF_RAW PCT_DIFF_RAW <<<"$(awk -v m="$MEP" -v c="$CCL" 'BEGIN{
    d=m-c; if (d<0) d=-d;
    a=(m+c)/2; p=0; if (a>0) p=(d/a)*100;
    printf "%.10f %.10f", d, p
  }')"
  SIMILAR="$(awk -v d="$ABS_DIFF_RAW" -v p="$PCT_DIFF_RAW" -v md="$SIMILARITY_MAX_DIFF_ARS" -v mp="$SIMILARITY_MAX_DIFF_PERCENT" 'BEGIN{
    if (d<=md || p<=mp) print "1"; else print "0"
  }')"
  ABS_DIFF="$(awk -v d="$ABS_DIFF_RAW" 'BEGIN{printf "%.2f", d}')"
  PCT_DIFF="$(awk -v p="$PCT_DIFF_RAW" 'BEGIN{printf "%.2f", p}')"
else
  SOURCE_STATUS_TEXT="ERROR DE FUENTE"
  SOURCE_STATUS_COLOR="#a61b1b"
fi

MEP_HUMAN_TS="$(format_ts "$MEP_TS")"
CCL_HUMAN_TS="$(format_ts "$CCL_TS")"

STATUS_TEXT="NO SIMILAR"
STATUS_COLOR="#a61b1b"
if [[ "$SCRAPE_OK" == "1" && "$SIMILAR" == "1" ]]; then
  STATUS_TEXT="SIMILARES"
  STATUS_COLOR="#0f7a36"
fi
if [[ "$SCRAPE_OK" != "1" ]]; then
  STATUS_TEXT="SIN DATOS"
  STATUS_COLOR="#7c3f00"
fi

if [[ "$SCRAPE_OK" == "1" ]]; then
  mkdir -p "$(dirname "$HISTORY_LOG")"
  echo "${NOW_EPOCH}|${NOW_HUMAN}|${MEP}|${CCL}|${ABS_DIFF}|${PCT_DIFF}|${SIMILAR}" >> "$HISTORY_LOG"
  if [[ -f "$HISTORY_LOG" ]]; then
    tmp_hist="$(mktemp)"
    tail -n "$HISTORY_MAX_ITEMS" "$HISTORY_LOG" > "$tmp_hist" && mv "$tmp_hist" "$HISTORY_LOG"
  fi
fi

HISTORY_JSON="[]"
if [[ -f "$HISTORY_LOG" ]]; then
  HISTORY_JSON="$(awk -F'\\|' 'BEGIN{first=1; printf "["}
    NF>=7 {
      if (!first) printf ",";
      first=0;
      gsub(/"/, "\\\"", $2);
      printf "{\"epoch\":%s,\"label\":\"%s\",\"mep\":%s,\"ccl\":%s,\"abs_diff\":%s,\"pct_diff\":%s,\"similar\":%s}",
      $1,$2,$3,$4,$5,$6,($7=="1"?"true":"false");
    }
    END{printf "]"}' "$HISTORY_LOG")"
fi

cat >"$OUTPUT_HTML" <<EOF
<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="refresh" content="60" />
  <title>Monitor Dolar MEP/CCL</title>
  <style>
    body{font-family:Arial,sans-serif;background:#f3f5f7;color:#1b1b1b;margin:0;padding:24px}
    .card{max-width:820px;margin:0 auto;background:#fff;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.08);padding:24px}
    .status{display:inline-block;padding:8px 14px;border-radius:999px;color:#fff;font-weight:700;background:${STATUS_COLOR}}
    .chip{display:inline-block;padding:6px 10px;border-radius:999px;color:#fff;font-size:12px;font-weight:700}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:18px}
    .box{background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px;padding:12px}
    .k{font-size:12px;color:#555;text-transform:uppercase;letter-spacing:.6px}
    .v{font-size:24px;font-weight:700;margin-top:6px}
    .f{font-size:14px;color:#333;margin-top:10px}
    .muted{font-size:13px;color:#666}
    .warn{background:#fff7e6;border:1px solid #f1c27d;border-radius:10px;padding:10px;margin-top:12px;color:#6e4b00}
    canvas{width:100%;max-width:100%;height:260px;background:#fff;border:1px solid #e5e7eb;border-radius:10px}
    table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}
    th,td{border-bottom:1px solid #e5e7eb;padding:8px;text-align:left}
    th{background:#f8fafc}
  </style>
</head>
<body>
  <div class="card">
    <h1>Monitor Dolar MEP vs CCL</h1>
    <p class="muted">Actualizado: ${NOW_HUMAN}</p>
    <p><span class="chip" style="background:${MARKET_COLOR}">Mercado ARG: ${MARKET_STATUS}</span> <span class="chip" style="background:${SOURCE_STATUS_COLOR}">Fuente: ${SOURCE_STATUS_TEXT}</span></p>
    <p><span class="status">${STATUS_TEXT}</span></p>
    $( [[ "$SCRAPE_OK" == "1" ]] || echo "<div class=\"warn\">No se pudieron obtener datos nuevos. Se muestra el último estado disponible del historial.</div>" )
    <div class="grid">
      <div class="box"><div class="k">MEP venta</div><div class="v">\$${MEP:-N/D}</div><div class="muted">Ref: ${MEP_HUMAN_TS}</div></div>
      <div class="box"><div class="k">CCL venta</div><div class="v">\$${CCL:-N/D}</div><div class="muted">Ref: ${CCL_HUMAN_TS}</div></div>
      <div class="box"><div class="k">Diferencia absoluta</div><div class="v">\$${ABS_DIFF}</div></div>
      <div class="box"><div class="k">Diferencia porcentual</div><div class="v">${PCT_DIFF}%</div></div>
    </div>
    <h2 style="margin-top:18px">Tendencia reciente</h2>
    <canvas id="trendChart" width="780" height="260"></canvas>
    <h2 style="margin-top:18px">Historial</h2>
    <table>
      <thead><tr><th>Hora</th><th>MEP</th><th>CCL</th><th>Dif \$</th><th>Dif %</th><th>Estado</th></tr></thead>
      <tbody id="historyRows"></tbody>
    </table>
    <p class="f">Condicion de similitud: diferencia <= ${SIMILARITY_MAX_DIFF_ARS} ARS o <= ${SIMILARITY_MAX_DIFF_PERCENT}%</p>
    <p class="muted">Fuente: <a href="${SOURCE_URL}" target="_blank">${SOURCE_URL}</a></p>
  </div>
  <script>
    const historyData = ${HISTORY_JSON};
    const rows = document.getElementById("historyRows");
    const visible = historyData.slice(-20).reverse();
    for (const r of visible) {
      const tr = document.createElement("tr");
      tr.innerHTML = "<td>" + r.label + "</td>"
        + "<td>$" + Number(r.mep).toFixed(2) + "</td>"
        + "<td>$" + Number(r.ccl).toFixed(2) + "</td>"
        + "<td>$" + Number(r.abs_diff).toFixed(2) + "</td>"
        + "<td>" + Number(r.pct_diff).toFixed(2) + "%</td>"
        + "<td>" + (r.similar ? "SIMILAR" : "NO") + "</td>";
      rows.appendChild(tr);
    }

    const canvas = document.getElementById("trendChart");
    const ctx = canvas.getContext("2d");
    const data = historyData.slice(-40);
    if (!data.length) {
      ctx.fillStyle = "#666";
      ctx.font = "14px Arial";
      ctx.fillText("Sin historial disponible", 20, 40);
    } else {
      const values = data.flatMap((d) => [Number(d.mep), Number(d.ccl)]);
      const min = Math.min(...values) * 0.995;
      const max = Math.max(...values) * 1.005;
      const w = canvas.width;
      const h = canvas.height;
      const pad = 32;
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
        ctx.lineWidth = 2;
        ctx.beginPath();
        data.forEach((d, i) => {
          const px = x(i), py = y(Number(d[key]));
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.stroke();
      };
      drawLine("mep", "#0f7a36");
      drawLine("ccl", "#1d4ed8");

      ctx.fillStyle = "#0f7a36"; ctx.fillRect(pad, 8, 10, 10); ctx.fillStyle = "#111"; ctx.fillText("MEP", pad + 14, 17);
      ctx.fillStyle = "#1d4ed8"; ctx.fillRect(pad + 60, 8, 10, 10); ctx.fillStyle = "#111"; ctx.fillText("CCL", pad + 74, 17);
    }
  </script>
</body>
</html>
EOF

printf "MEP=%s | CCL=%s | dif=%s (%s%%) | similar=%s\n" "$MEP" "$CCL" "$ABS_DIFF" "$PCT_DIFF" "$SIMILAR"

if [[ "$SCRAPE_OK" != "1" ]]; then
  exit 0
fi

if [[ "$SIMILAR" != "1" ]]; then
  exit 0
fi

LAST_ALERT_EPOCH=0
if [[ -f "$STATE_FILE" ]]; then
  LAST_ALERT_EPOCH="$(awk -F= '$1=="LAST_ALERT_EPOCH"{print $2}' "$STATE_FILE" 2>/dev/null || echo 0)"
fi
LAST_ALERT_EPOCH="${LAST_ALERT_EPOCH:-0}"

CAN_SEND="$(awk -v now="$NOW_EPOCH" -v last="$LAST_ALERT_EPOCH" -v cool="$ALERT_COOLDOWN_MINUTES" 'BEGIN{
  if (last==0 || (now-last) >= cool*60) print "1"; else print "0"
}')"

if [[ "$CAN_SEND" != "1" ]]; then
  echo "Similar, pero dentro del cooldown. No se envia email."
  exit 0
fi

SUBJECT="[Alerta] MEP y CCL similares (dif \$${ABS_DIFF})"
BODY="$(cat <<EOF
Se detecto que MEP y CCL estan similares.

MEP (venta): \$${MEP}
CCL (venta): \$${CCL}
Diferencia absoluta: \$${ABS_DIFF}
Diferencia porcentual: ${PCT_DIFF}%

Actualizacion MEP: $(format_ts "$MEP_TS")
Actualizacion CCL: $(format_ts "$CCL_TS")
Chequeado: $NOW_HUMAN

Fuente: $SOURCE_URL
EOF
)"

SMTP_HOST="${SMTP_HOST:-}"
SMTP_USER="${SMTP_USER:-}"
SMTP_PASS="${SMTP_PASS:-}"
SMTP_FROM="${SMTP_FROM:-}"
SMTP_TO="${SMTP_TO:-}"

if [[ -z "$SMTP_HOST" || -z "$SMTP_USER" || -z "$SMTP_PASS" || -z "$SMTP_FROM" || -z "$SMTP_TO" ]]; then
  echo "SMTP incompleto: se omite envio de email (panel web sigue funcionando)."
  cat >"$STATE_FILE" <<EOF
LAST_ALERT_EPOCH=${NOW_EPOCH}
LAST_MEP=${MEP}
LAST_CCL=${CCL}
EOF
  exit 0
fi

MAIL_FILE="$(mktemp)"
cat >"$MAIL_FILE" <<EOF
From: ${SMTP_FROM}
To: ${SMTP_TO}
Subject: ${SUBJECT}
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8

${BODY}
EOF

if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY RUN: se habria enviado este mensaje:"
  cat "$MAIL_FILE"
  rm -f "$MAIL_FILE"
  exit 0
fi

SMTP_URL="smtp://${SMTP_HOST}:${SMTP_PORT}"
if [[ "${SMTP_USE_TLS:l}" == "true" || "${SMTP_USE_TLS}" == "1" ]]; then
  TLS_FLAG="--ssl-reqd"
else
  TLS_FLAG=""
fi

RCPTS=()
for rcpt in ${(s:,:)SMTP_TO}; do
  clean="${rcpt## }"
  clean="${clean%% }"
  [[ -n "$clean" ]] && RCPTS+=("--mail-rcpt" "$clean")
done

curl -sS $TLS_FLAG \
  --url "$SMTP_URL" \
  --user "${SMTP_USER}:${SMTP_PASS}" \
  --mail-from "$SMTP_FROM" \
  "${RCPTS[@]}" \
  --upload-file "$MAIL_FILE"

echo "Email enviado."
cat >"$STATE_FILE" <<EOF
LAST_ALERT_EPOCH=${NOW_EPOCH}
LAST_MEP=${MEP}
LAST_CCL=${CCL}
EOF

rm -f "$MAIL_FILE"
