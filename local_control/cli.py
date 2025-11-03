"""
Command-line entry point for launching the LAN control server.
"""

from __future__ import annotations

import argparse
import logging
from typing import Iterable, Optional

from .app import create_app


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Start the LAN Control server to steer this machine remotely.",
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
    return parser


def main(argv: Optional[Iterable[str]] = None) -> None:
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)

    logging.basicConfig(level=logging.INFO)
    app = create_app()
    app.run(host=args.host, port=args.port, debug=args.debug)
