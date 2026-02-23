# Radar MEP vs CCL - Cloudflare Worker

Monitor web de dolar MEP y CCL con actualización automática en la nube, sin depender de PC encendida.

## Arquitectura

- **Cloudflare Worker**:
  - corre cron cada 5 minutos en horario de mercado ARG (10:30 a 17:59 ART, lunes a viernes),
  - consulta `https://www.dolarito.ar/cotizacion/dolar-hoy`,
  - calcula brecha absoluta y porcentual,
  - guarda estado e historial en KV.
- **KV (MONITOR_KV)**:
  - persiste historial y último estado entre ejecuciones.
- **Dashboard web**:
  - servido por el mismo Worker,
  - consume `/api/data` cada 60 segundos,
  - muestra estado, métricas 24h, historial y gráfico.

## Cron (UTC)

En `wrangler.toml`:

- `30-59/5 13 * * MON-FRI`
- `*/5 14-20 * * MON-FRI`

Equivale a 10:30-17:59 ART cada 5 minutos.

## Variables y seguridad

No se usan credenciales en el frontend.

Para deploy por GitHub Actions se usan secretos del repo:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Nunca se commitean tokens ni `.env`.

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
npm run dev
```

## Seguridad automatizada

`security_check.sh` valida:

- que no haya archivos sensibles trackeados,
- que no existan llaves privadas en el repo,
- que no se expongan tokens/API keys en código público.
