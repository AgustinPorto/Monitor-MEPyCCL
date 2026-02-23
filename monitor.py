#!/usr/bin/env python3
import argparse
import json
import os
import re
import smtplib
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path
from typing import Optional

import requests
from dotenv import load_dotenv

SOURCE_URL = "https://www.dolarito.ar/cotizacion/dolar-hoy"
DEFAULT_STATE_FILE = ".dolar_monitor_state.json"


@dataclass
class Config:
    max_diff_ars: float
    max_diff_percent: float
    cooldown_minutes: int
    state_file: Path
    check_interval_minutes: int
    smtp_host: str
    smtp_port: int
    smtp_user: str
    smtp_pass: str
    smtp_from: str
    smtp_to: list[str]
    smtp_use_tls: bool


@dataclass
class DollarSnapshot:
    mep_sell: float
    ccl_sell: float
    mep_timestamp_ms: Optional[int] = None
    ccl_timestamp_ms: Optional[int] = None

    @property
    def abs_diff(self) -> float:
        return abs(self.mep_sell - self.ccl_sell)

    @property
    def pct_diff(self) -> float:
        avg = (self.mep_sell + self.ccl_sell) / 2
        if avg <= 0:
            return 0.0
        return (self.abs_diff / avg) * 100


def env_required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise ValueError(f"Falta la variable de entorno obligatoria: {name}")
    return value


def load_config() -> Config:
    load_dotenv()
    smtp_to_raw = env_required("SMTP_TO")
    smtp_to = [item.strip() for item in smtp_to_raw.split(",") if item.strip()]
    if not smtp_to:
        raise ValueError("SMTP_TO debe tener al menos un destinatario.")

    return Config(
        max_diff_ars=float(os.getenv("SIMILARITY_MAX_DIFF_ARS", "12")),
        max_diff_percent=float(os.getenv("SIMILARITY_MAX_DIFF_PERCENT", "1.0")),
        cooldown_minutes=int(os.getenv("ALERT_COOLDOWN_MINUTES", "120")),
        state_file=Path(os.getenv("STATE_FILE", DEFAULT_STATE_FILE)),
        check_interval_minutes=int(os.getenv("CHECK_INTERVAL_MINUTES", "5")),
        smtp_host=env_required("SMTP_HOST"),
        smtp_port=int(os.getenv("SMTP_PORT", "587")),
        smtp_user=env_required("SMTP_USER"),
        smtp_pass=env_required("SMTP_PASS"),
        smtp_from=env_required("SMTP_FROM"),
        smtp_to=smtp_to,
        smtp_use_tls=os.getenv("SMTP_USE_TLS", "true").lower() in {"1", "true", "yes", "y"},
    )


def fetch_page(url: str) -> str:
    response = requests.get(
        url,
        timeout=20,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
            )
        },
    )
    response.raise_for_status()
    return response.text


def _extract_number(field: str, html: str) -> float:
    pattern = rf'"{field}":\{{.*?"sell":([0-9]+(?:\.[0-9]+)?)'
    match = re.search(pattern, html, flags=re.DOTALL)
    if not match:
        raise ValueError(f"No pude encontrar el valor de venta para {field}.")
    return float(match.group(1))


def _extract_timestamp(field: str, html: str) -> Optional[int]:
    pattern = rf'"{field}":\{{.*?"timestamp":([0-9]+)'
    match = re.search(pattern, html, flags=re.DOTALL)
    if not match:
        return None
    return int(match.group(1))


def parse_snapshot(html: str) -> DollarSnapshot:
    mep_sell = _extract_number("mep", html)
    ccl_sell = _extract_number("ccl", html)
    mep_ts = _extract_timestamp("mep", html)
    ccl_ts = _extract_timestamp("ccl", html)
    return DollarSnapshot(mep_sell=mep_sell, ccl_sell=ccl_sell, mep_timestamp_ms=mep_ts, ccl_timestamp_ms=ccl_ts)


def is_similar(snapshot: DollarSnapshot, config: Config) -> bool:
    return snapshot.abs_diff <= config.max_diff_ars or snapshot.pct_diff <= config.max_diff_percent


def load_state(path: Path) -> dict:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_state(path: Path, state: dict) -> None:
    with path.open("w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=True, indent=2)


def should_send_alert(state: dict, now_utc: datetime, cooldown_minutes: int) -> bool:
    last_iso = state.get("last_alert_at_utc")
    if not last_iso:
        return True
    try:
        last = datetime.fromisoformat(last_iso)
    except ValueError:
        return True
    return now_utc - last >= timedelta(minutes=cooldown_minutes)


def format_ts(ms: Optional[int]) -> str:
    if ms is None:
        return "s/dato"
    dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc).astimezone()
    return dt.strftime("%Y-%m-%d %H:%M:%S %Z")


def build_email(snapshot: DollarSnapshot, config: Config) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = config.smtp_from
    msg["To"] = ", ".join(config.smtp_to)
    msg["Subject"] = f"[Alerta] MEP y CCL similares (dif ${snapshot.abs_diff:,.2f})"
    msg.set_content(
        "\n".join(
            [
                "Se detectó que los dólares MEP y CCL están similares.",
                "",
                f"MEP (venta): ${snapshot.mep_sell:,.2f}",
                f"CCL (venta): ${snapshot.ccl_sell:,.2f}",
                f"Diferencia absoluta: ${snapshot.abs_diff:,.2f}",
                f"Diferencia porcentual: {snapshot.pct_diff:.3f}%",
                "",
                f"Actualización MEP: {format_ts(snapshot.mep_timestamp_ms)}",
                f"Actualización CCL: {format_ts(snapshot.ccl_timestamp_ms)}",
                "",
                f"Fuente: {SOURCE_URL}",
            ]
        )
    )
    return msg


def send_email(config: Config, msg: EmailMessage) -> None:
    if config.smtp_use_tls and config.smtp_port != 465:
        with smtplib.SMTP(config.smtp_host, config.smtp_port, timeout=30) as server:
            server.ehlo()
            server.starttls()
            server.ehlo()
            server.login(config.smtp_user, config.smtp_pass)
            server.send_message(msg)
    else:
        with smtplib.SMTP_SSL(config.smtp_host, config.smtp_port, timeout=30) as server:
            server.login(config.smtp_user, config.smtp_pass)
            server.send_message(msg)


def run_once(config: Config, dry_run: bool = False) -> int:
    now_utc = datetime.now(timezone.utc)
    state = load_state(config.state_file)

    html = fetch_page(SOURCE_URL)
    snapshot = parse_snapshot(html)

    similar = is_similar(snapshot, config)
    print(
        (
            f"MEP=${snapshot.mep_sell:.2f} | CCL=${snapshot.ccl_sell:.2f} | "
            f"dif=${snapshot.abs_diff:.2f} ({snapshot.pct_diff:.3f}%) | similar={similar}"
        )
    )

    if not similar:
        return 0

    if not should_send_alert(state, now_utc, config.cooldown_minutes):
        print("Similar, pero dentro de ventana de cooldown. No se envía email.")
        return 0

    msg = build_email(snapshot, config)
    if dry_run:
        print("DRY RUN: se habría enviado este correo:\n")
        print(msg)
    else:
        send_email(config, msg)
        print("Email enviado.")

    state["last_alert_at_utc"] = now_utc.isoformat()
    state["last_mep_sell"] = snapshot.mep_sell
    state["last_ccl_sell"] = snapshot.ccl_sell
    save_state(config.state_file, state)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Monitor de dólar MEP/CCL con alertas por email.")
    parser.add_argument("--dry-run", action="store_true", help="No envía email; muestra el contenido que enviaría.")
    parser.add_argument("--watch", action="store_true", help="Ejecuta en bucle cada CHECK_INTERVAL_MINUTES.")
    args = parser.parse_args()

    try:
        config = load_config()
    except Exception as exc:
        print(f"Error de configuración: {exc}", file=sys.stderr)
        return 2

    if not args.watch:
        try:
            return run_once(config, dry_run=args.dry_run)
        except Exception as exc:
            print(f"Error de ejecución: {exc}", file=sys.stderr)
            return 1

    print(f"Monitoreo continuo activo. Intervalo: {config.check_interval_minutes} min")
    while True:
        try:
            run_once(config, dry_run=args.dry_run)
        except Exception as exc:
            print(f"Error de ejecución: {exc}", file=sys.stderr)
        time.sleep(max(config.check_interval_minutes, 1) * 60)


if __name__ == "__main__":
    raise SystemExit(main())
