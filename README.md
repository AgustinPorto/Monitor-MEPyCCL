# Radar MEP vs CCL - Cloudflare Worker

Monitor web de dolar MEP y CCL con actualización automática en la nube, sin depender de PC encendida.

## Arquitectura

- **Cloudflare Worker**:
  - corre cron cada 5 minutos en horario de mercado ARG (10:30 a 17:59 ART, lunes a viernes),
  - consulta `https://www.dolarito.ar/cotizacion/dolar-hoy`,
  - calcula brecha absoluta y porcentual,
  - guarda estado e historial en KV,
  - refresca FCI (renta fija y variable) una vez por hora,
  - refresca benchmarks una vez por día hábil (primer tick del mercado, 10:30 ART).
- **KV (MONITOR_KV)**:
  - persiste historial y último estado entre ejecuciones.
- **Dashboard web**:
  - servido por el mismo Worker,
  - consume `/api/data` cada 60 segundos,
  - muestra estado, métricas 24h, historial y gráfico.

## Núcleo de dominio

La lógica pura (sin `fetch` ni KV) vive en:

- `src/domain/core.js`

Incluye:

- `calcSpreadAbs`
- `calcSpreadPctRatio`
- `toPercent`
- `isSimilar`
- `calcStalenessSeconds`
- `isMarketOpen`

## Contrato de porcentajes (unidades explícitas)

- Interno (dominio): **ratio**
  - `spreadPctRatio` donde `0.01 = 1%`.
- Borde API/UI: **porcentaje humano**
  - `spreadPctPercent` donde `1 = 1%`.
- Compatibilidad pública:
  - `pct_diff` se mantiene en porcentaje humano.
  - internamente se calcula ratio y se convierte una sola vez en el borde.

## Estados de confianza de datos

- `OK`: `staleness <= 10 minutos`.
- `DELAYED`: `10 minutos < staleness <= 60 minutos`.
- `NO_DATA`: no existe snapshot válido.

Cuando falla `fetch` o validación/parsing, el Worker intenta responder con el último snapshot válido en vez de romper la UI/API.

## Cron (UTC)

En `wrangler.toml`:

- `30-59/5 13 * * MON-FRI`
- `*/5 14-20 * * MON-FRI`

Equivale a 10:30-17:59 ART cada 5 minutos.

## Frecuencias reales de actualización

Dentro de esa ventana de cron (Lun-Vie 10:30-17:59 ART):

- **MEP/CCL + estado principal**: cada **5 minutos**.
- **FCI (renta fija y renta variable)**: cada **1 hora** (en el minuto `:30`).
- **Benchmarks (plazo fijo e inflación)**: **1 vez por día hábil** (a las **10:30 ART**).

Nota: el frontend puede consultar endpoints más seguido, pero los datos en KV se refrescan con estas frecuencias.

## Variables y seguridad

No se usan credenciales en el frontend.

Para deploy por GitHub Actions se usan secretos del repo:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Nunca se commitean tokens ni `.env`.

### Alertas por email (SIMILAR)

El Worker puede enviar email cuando detecta estado `SIMILAR`.

Variables de Worker (`wrangler.toml`):

- `EMAIL_ALERTS_ENABLED` (`"true"` o `"false"`)
- `ALERT_COOLDOWN_MINUTES` (ej: `"120"`)
- `WORKER_PUBLIC_URL` (URL pública del dashboard)

Secrets de Cloudflare Worker (no en GitHub):

- `RESEND_API_KEY`
- `ALERT_TO_EMAIL`
- `ALERT_FROM_EMAIL` (dominio verificado en Resend)

Ejemplo para cargar secrets desde terminal:

```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put ALERT_TO_EMAIL
npx wrangler secret put ALERT_FROM_EMAIL
```

## Deploy en Cloudflare (una sola vez)

1. Crear KV namespace en Cloudflare:
   - `MONITOR_KV`
2. Guardar IDs del namespace (`id` y `preview_id`) para cargarlos como secretos.
3. En GitHub repo -> Settings -> Secrets and variables -> Actions:
   - agregar `CLOUDFLARE_API_TOKEN`
   - agregar `CLOUDFLARE_ACCOUNT_ID`
   - agregar `CLOUDFLARE_KV_NAMESPACE_ID`
   - agregar `CLOUDFLARE_KV_PREVIEW_ID`
4. Push a `main` (o correr workflow manual `Deploy Cloudflare Worker`).

## URL final

Queda publicada como:

- `https://<worker-name>.<subdominio>.workers.dev`

El dashboard está en `/` y API en `/api/data`.

## Desarrollo local

```bash
npm install
npm run check
npm test
npm run dev
```

## Sincronización dashboard embed

`dashboard_worker_source.html` es la fuente de verdad del dashboard.

Antes de deploy, sincronizar embed en `src/index.js`:

```bash
npm run sync:dashboard
```

Verificación de drift:

```bash
npm run check:dashboard-embed
```

CI falla si el embed está fuera de sync.

## Seguridad automatizada

`security_check.sh` valida:

- que no haya archivos sensibles trackeados,
- que no existan llaves privadas en el repo,
- que no se expongan tokens/API keys en código público.
