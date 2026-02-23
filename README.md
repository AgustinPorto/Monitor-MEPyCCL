# Monitor MEP vs CCL (Web)

Genera un dashboard web estático con:
- Dólar MEP (venta)
- Dólar CCL (venta)
- Diferencia absoluta y porcentual (redondeadas a 2 decimales)
- Estado `SIMILARES` / `NO SIMILAR`
- Historial de ejecuciones recientes
- Gráfico de tendencia MEP vs CCL
- Estado de mercado argentino (`ABIERTO`/`CERRADO`)
- Manejo robusto de errores de fuente (sin romper dashboard)
- Métricas de brecha en 24h (min/max/promedio + conteo de `SIMILAR`)
- Indicador de frescura del dato de fuente (minutos desde último timestamp)

Fuente: `https://www.dolarito.ar/cotizacion/dolar-hoy`

## Ejecución local

```bash
/bin/zsh ./monitor.sh
```

Salida web:
- `public/dashboard.html` (archivo para publicar)

Archivos locales de soporte:
- `.dolar_history.log` (historial para tabla/gráfico)
- `.dolar_monitor_state` (estado interno de alertas)

## Programación local (cron)

Configurado para mercado abierto en Argentina:
- Lunes a viernes
- 11:00 a 17:59 ART
- cada 15 minutos

Entrada actual:

```cron
CRON_TZ=America/Argentina/Buenos_Aires
*/15 11-17 * * 1-5 cd /Users/agustinporto/Documents/New\ project && /bin/zsh /Users/agustinporto/Documents/New\ project/monitor.sh >> /Users/agustinporto/Documents/New\ project/monitor.log 2>&1
```

## Hosting fijo (GitHub Pages)

Ya quedó preparado:
- Workflow: `.github/workflows/publish-dashboard.yml`
- Publicación desde `public/`
- Schedule de GitHub Actions: `*/15 14-20 * * 1-5` (equivalente UTC del horario ART)

Para activarlo:
1. Crear repo en GitHub.
2. Subir este proyecto.
3. En GitHub, habilitar Pages (`Settings > Pages > Source: GitHub Actions`).
4. Ejecutar el workflow `Publish Dashboard` (manual o esperar próximo cron).

URL final esperada:
- `https://<usuario>.github.io/<repo>/dashboard.html`

## Seguridad aplicada

- `.env` está excluido del repositorio (`.gitignore`).
- Publicación solo de `public/dashboard.html`.
- `security_check.sh` bloquea:
  - archivos sensibles trackeados (`.env`, logs, state)
  - llaves privadas en el repo
  - exposición de rutas locales o claves SMTP en `dashboard.html`

Ejecutar chequeo:

```bash
./security_check.sh
```
