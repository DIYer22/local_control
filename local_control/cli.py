"""
Command-line entry point for launching the local control server.
"""

from __future__ import annotations

import argparse
import logging
import os
import socket
import sys
from typing import Iterable, List, Optional

from .app import create_app
from .startup import StartupManager, StartupError
from .utils.terminal_qr import render_text


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Start the local Control server to steer this machine remotely.",
    )
    parser.add_argument(
        "--host",
        default="0.0.0.0",
        help="Host/IP to bind (default: 0.0.0.0 for all interfaces).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=4001,
        help="Port to listen on (default: 4001).",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable Flask debug mode.",
    )
    parser.add_argument(
        "--startup",
        action="store_true",
        help="Register this server to launch automatically for the current user.",
    )
    parser.add_argument(
        "--startup-cancel",
        action="store_true",
        help="Remove the auto-start registration created with --startup.",
    )
    return parser


def main(argv: Optional[Iterable[str]] = None) -> None:
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.startup and args.startup_cancel:
        parser.error("Choose only one of --startup or --startup-cancel.")

    if args.startup or args.startup_cancel:
        manager = StartupManager(args.host, args.port, args.debug)
        try:
            if args.startup:
                manager.enable()
                print("Startup entry created. Local Control will launch on login.")
            else:
                manager.disable()
                print("Startup entry removed.")
        except StartupError as exc:
            print(f"Startup configuration failed: {exc}", file=sys.stderr)
            sys.exit(1)
        return

    logging.basicConfig(level=logging.INFO)
    app = create_app()
    if not args.debug or os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        _display_banner(args.host, args.port)
    app.run(host=args.host, port=args.port, debug=args.debug)


def _display_banner(host: str, port: int) -> None:
    urls = _candidate_urls(host, port)
    if not urls:
        return
    primary = next((url for url in urls if not url.startswith("http://127.")), urls[0])

    print("Local Control server ready. Reach it at:", flush=True)
    for url in urls:
        print(f"  • {url}", flush=True)

    try:
        qr_text = render_text(primary)
    except Exception as exc:  # pragma: no cover - cosmetic
        logging.debug("Failed to render QR code: %s", exc)
        return

    print("\nScan to connect:", flush=True)
    print(qr_text, flush=True)


def _candidate_urls(host: str, port: int) -> List[str]:
    hosts: List[str] = []
    if host in {"0.0.0.0", "::", "", "*"}:
        hosts.extend(_local_ipv4_addresses())
        hosts.append("127.0.0.1")
        hosts.append("localhost")
    else:
        hosts.append(host)
        if host not in {"127.0.0.1", "localhost"}:
            hosts.append("127.0.0.1")
            hosts.append("localhost")

    normalized = []
    for h in hosts:
        if ":" in h and not h.startswith("["):
            normalized.append(f"http://[{h}]:{port}")
        else:
            normalized.append(f"http://{h}:{port}")

    seen = set()
    unique_urls = []
    for url in normalized:
        if url not in seen:
            seen.add(url)
            unique_urls.append(url)
    return unique_urls


def _local_ipv4_addresses() -> List[str]:
    candidates = set()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            candidates.add(sock.getsockname()[0])
    except OSError:
        pass
    try:
        hostname = socket.gethostname()
        for addr in socket.gethostbyname_ex(hostname)[2]:
            if addr and addr != "127.0.0.1":
                candidates.add(addr)
    except socket.gaierror:
        pass
    return sorted(candidates)
