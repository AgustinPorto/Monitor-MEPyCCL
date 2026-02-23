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

FRESH_SOURCE_LABEL="N/D"
FRESH_SOURCE_WARN=0
LATEST_SOURCE_TS_MS=""
if is_number "$MEP_TS" && is_number "$CCL_TS"; then
  if [[ "$MEP_TS" -ge "$CCL_TS" ]]; then
    LATEST_SOURCE_TS_MS="$MEP_TS"
  else
    LATEST_SOURCE_TS_MS="$CCL_TS"
  fi
elif is_number "$MEP_TS"; then
  LATEST_SOURCE_TS_MS="$MEP_TS"
elif is_number "$CCL_TS"; then
  LATEST_SOURCE_TS_MS="$CCL_TS"
fi

if [[ -n "$LATEST_SOURCE_TS_MS" ]]; then
  SOURCE_AGE_MIN="$(awk -v now="$NOW_EPOCH" -v ts="$LATEST_SOURCE_TS_MS" 'BEGIN{
    m=(now-(ts/1000))/60;
    if (m<0) m=0;
    printf "%d", m
  }')"
  if [[ "$SOURCE_AGE_MIN" -lt 60 ]]; then
    FRESH_SOURCE_LABEL="${SOURCE_AGE_MIN} min"
  else
    SOURCE_AGE_HOURS="$(awk -v m="$SOURCE_AGE_MIN" 'BEGIN{printf "%.1f", m/60}')"
    FRESH_SOURCE_LABEL="${SOURCE_AGE_HOURS} h"
  fi
  if [[ "$SOURCE_AGE_MIN" -gt 60 ]]; then
    FRESH_SOURCE_WARN=1
  fi
fi

METRICS_COUNT=0
METRICS_SIMILAR_COUNT=0
METRICS_MIN_PCT="N/D"
METRICS_MAX_PCT="N/D"
METRICS_AVG_PCT="N/D"
if [[ -f "$HISTORY_LOG" ]]; then
  read -r METRICS_COUNT METRICS_SIMILAR_COUNT METRICS_MIN_PCT METRICS_MAX_PCT METRICS_AVG_PCT <<<"$(awk -F'\\|' -v cutoff="$((NOW_EPOCH-86400))" '
    BEGIN{cnt=0; sim=0; min=1e9; max=-1e9; sum=0}
    NF>=7 && $1+0>=cutoff {
      p=$6+0;
      cnt++;
      if ($7=="1") sim++;
      if (p<min) min=p;
      if (p>max) max=p;
      sum+=p;
    }
    END{
      if (cnt==0) { print "0 0 N/D N/D N/D"; exit }
      printf "%d %d %.2f %.2f %.2f", cnt, sim, min, max, (sum/cnt);
    }' "$HISTORY_LOG")"
fi

cat >"$OUTPUT_HTML" <<EOF
<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="refresh" content="60" />
  <title>Radar MEP/CCL</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
  <style>
    :root{
      --bg-1:#f4f7fb;
      --bg-2:#e6edf8;
      --ink:#0f172a;
      --muted:#475569;
      --card:#ffffff;
      --line:#d9e2ef;
      --brand:#0f4c81;
      --accent:#0ea5a6;
      --warn-bg:#fff6e8;
      --warn-line:#f3c17a;
      --warn-ink:#7a4e12;
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      min-height:100vh;
      font-family:"IBM Plex Sans",sans-serif;
      color:var(--ink);
      background:
        radial-gradient(1300px 500px at -10% -20%, #d9e6fa 0%, transparent 60%),
        radial-gradient(900px 500px at 110% -10%, #d9f5ef 0%, transparent 55%),
        linear-gradient(180deg,var(--bg-1) 0%, var(--bg-2) 100%);
      padding:20px;
    }
    .card{
      max-width:980px;
      margin:0 auto;
      background:var(--card);
      border:1px solid var(--line);
      border-radius:20px;
      box-shadow:0 20px 40px rgba(15,23,42,.08);
      padding:22px;
    }
    h1,h2,h3{font-family:"Sora",sans-serif;margin:0}
    h1{font-size:28px;letter-spacing:-.02em}
    h2{font-size:20px;margin-top:20px}
    .top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap}
    .updated{color:var(--muted);font-size:13px;margin-top:6px}
    .pills{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
    .status{display:inline-block;padding:8px 14px;border-radius:999px;color:#fff;font-weight:700;background:${STATUS_COLOR};font-family:"Sora",sans-serif}
    .chip{display:inline-block;padding:6px 10px;border-radius:999px;color:#fff;font-size:12px;font-weight:700}
    .tabs{display:flex;gap:8px;margin-top:16px;border-bottom:1px solid var(--line);padding-bottom:10px}
    .tab{
      border:1px solid var(--line);
      background:#f8fbff;
      color:var(--ink);
      border-radius:10px;
      padding:8px 12px;
      font-weight:600;
      cursor:pointer;
    }
    .tab.active{background:var(--brand);color:#fff;border-color:var(--brand)}
    .panel{display:none}
    .panel.active{display:block}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:14px}
    .grid.kpis{grid-template-columns:repeat(3,minmax(0,1fr))}
    .box{
      background:linear-gradient(180deg,#ffffff 0%, #f7fbff 100%);
      border:1px solid var(--line);
      border-radius:12px;
      padding:12px;
      min-height:86px;
    }
    .k{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.8px;font-weight:600}
    .v{font-size:24px;font-weight:800;margin-top:6px;font-family:"Sora",sans-serif}
    .muted{font-size:12px;color:var(--muted);margin-top:5px}
    .warn{background:var(--warn-bg);border:1px solid var(--warn-line);border-radius:12px;padding:10px;margin-top:10px;color:var(--warn-ink)}
    canvas{width:100%;max-width:100%;height:270px;background:#fff;border:1px solid var(--line);border-radius:12px;margin-top:10px}
    table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}
    th,td{border-bottom:1px solid var(--line);padding:9px;text-align:left}
    th{background:#f4f8fd;color:#334155}
    .foot{font-size:13px;color:var(--muted);margin-top:14px}
    .guide-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:14px}
    .guide-item{border:1px solid var(--line);background:#fbfdff;border-radius:12px;padding:12px}
    .guide-item h3{font-size:15px;margin-bottom:6px}
    .guide-item p{margin:0;color:#334155;font-size:14px;line-height:1.35}
    @media (max-width:860px){
      .grid,.grid.kpis,.guide-grid{grid-template-columns:1fr}
      h1{font-size:24px}
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="top">
      <div>
        <h1>Radar MEP vs CCL</h1>
        <div class="updated">Actualizado: ${NOW_HUMAN}</div>
        <div class="pills">
          <span class="chip" style="background:${MARKET_COLOR}">Mercado ARG: ${MARKET_STATUS}</span>
          <span class="chip" style="background:${SOURCE_STATUS_COLOR}">Fuente: ${SOURCE_STATUS_TEXT}</span>
          <span class="status">${STATUS_TEXT}</span>
        </div>
      </div>
      <div class="box" style="min-width:220px">
        <div class="k">Frescura dato fuente</div>
        <div class="v">${FRESH_SOURCE_LABEL}</div>
        <div class="muted">Minutos desde último timestamp MEP/CCL</div>
      </div>
    </div>

    <div class="tabs">
      <button class="tab active" data-tab="overview">Panel</button>
      <button class="tab" data-tab="guide">Glosario</button>
    </div>

    <section class="panel active" id="panel-overview">
      <div class="grid kpis">
        <div class="box"><div class="k">Muestras en 24h</div><div class="v">${METRICS_COUNT}</div><div class="muted">Registros totales en el período</div></div>
        <div class="box"><div class="k">Veces en SIMILAR (24h)</div><div class="v">${METRICS_SIMILAR_COUNT}</div><div class="muted">Cantidad de momentos en zona similar</div></div>
        <div class="box"><div class="k">Brecha % promedio (24h)</div><div class="v">${METRICS_AVG_PCT}%</div><div class="muted">Promedio de la diferencia porcentual</div></div>
      </div>

    $( [[ "$FRESH_SOURCE_WARN" == "1" ]] && echo "<div class=\"warn\">El dato de fuente está desactualizado (> 60 min).</div>" )
    $( [[ "$SCRAPE_OK" == "1" ]] || echo "<div class=\"warn\">No se pudieron obtener datos nuevos. Se muestra el último estado disponible del historial.</div>" )
    <div class="grid">
      <div class="box"><div class="k">MEP venta</div><div class="v">\$${MEP:-N/D}</div><div class="muted">Ref: ${MEP_HUMAN_TS}</div></div>
      <div class="box"><div class="k">CCL venta</div><div class="v">\$${CCL:-N/D}</div><div class="muted">Ref: ${CCL_HUMAN_TS}</div></div>
      <div class="box"><div class="k">Diferencia absoluta</div><div class="v">\$${ABS_DIFF}</div></div>
      <div class="box"><div class="k">Diferencia porcentual</div><div class="v">${PCT_DIFF}%</div></div>
      <div class="box"><div class="k">Brecha % mínima (24h)</div><div class="v">${METRICS_MIN_PCT}%</div></div>
      <div class="box"><div class="k">Brecha % máxima (24h)</div><div class="v">${METRICS_MAX_PCT}%</div></div>
    </div>
    <h2 style="margin-top:18px">Tendencia reciente</h2>
    <canvas id="trendChart" width="780" height="260"></canvas>
    <h2 style="margin-top:18px">Historial</h2>
    <table>
      <thead><tr><th>Hora</th><th>MEP</th><th>CCL</th><th>Dif \$</th><th>Dif %</th><th>Estado</th></tr></thead>
      <tbody id="historyRows"></tbody>
    </table>
    <p class="foot">Condición de similitud: diferencia <= ${SIMILARITY_MAX_DIFF_ARS} ARS o <= ${SIMILARITY_MAX_DIFF_PERCENT}%</p>
    <p class="foot">Fuente: <a href="${SOURCE_URL}" target="_blank">${SOURCE_URL}</a></p>
    </section>

    <section class="panel" id="panel-guide">
      <h2>Qué significa cada dato</h2>
      <div class="guide-grid">
        <article class="guide-item">
          <h3>MEP venta</h3>
          <p>Precio de venta del dólar MEP obtenido de la fuente. Es uno de los dos valores que se comparan.</p>
        </article>
        <article class="guide-item">
          <h3>CCL venta</h3>
          <p>Precio de venta del dólar CCL. Se usa junto con MEP para calcular la brecha entre ambos.</p>
        </article>
        <article class="guide-item">
          <h3>Diferencia absoluta</h3>
          <p>Distancia en pesos entre CCL y MEP. Fórmula: <strong>|MEP - CCL|</strong>.</p>
        </article>
        <article class="guide-item">
          <h3>Diferencia porcentual</h3>
          <p>Brecha relativa entre ambos dólares respecto del promedio de MEP y CCL.</p>
        </article>
        <article class="guide-item">
          <h3>Estado SIMILAR / NO SIMILAR</h3>
          <p>Se considera <strong>SIMILAR</strong> cuando la diferencia cumple el umbral configurado en pesos o en porcentaje.</p>
        </article>
        <article class="guide-item">
          <h3>Frescura del dato</h3>
          <p>Minutos desde el último timestamp recibido de la fuente. Si supera 60 min, aparece advertencia.</p>
        </article>
        <article class="guide-item">
          <h3>Métricas 24h</h3>
          <p>Resumen de las últimas 24 horas: cantidad de muestras, veces en similar y brecha mínima/máxima/promedio.</p>
        </article>
        <article class="guide-item">
          <h3>Mercado ARG</h3>
          <p>Indicador horario (Argentina) de ventana de mercado: lunes a viernes de 11:00 a 17:59.</p>
        </article>
      </div>
    </section>
  </div>
  <script>
    const tabButtons = Array.from(document.querySelectorAll(".tab"));
    const panels = {
      overview: document.getElementById("panel-overview"),
      guide: document.getElementById("panel-guide")
    };
    tabButtons.forEach(function(btn){
      btn.addEventListener("click", function(){
        const t = btn.getAttribute("data-tab");
        tabButtons.forEach(function(b){ b.classList.remove("active"); });
        btn.classList.add("active");
        Object.keys(panels).forEach(function(key){
          if (key === t) panels[key].classList.add("active");
          else panels[key].classList.remove("active");
        });
      });
    });

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
