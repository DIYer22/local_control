"""
Helpers for rendering QR codes as terminal-friendly ASCII art.
"""

from __future__ import annotations

import io
from typing import Iterable

import qrcode
from qrcode.constants import ERROR_CORRECT_L


def render_text(data: str) -> str:
    """
    Render a QR code pointing to ``data`` using the qrcode package's ASCII output.
    Returns the multi-line string that can be printed directly.
    """
    qr = qrcode.QRCode(
        error_correction=ERROR_CORRECT_L,
        box_size=1,
        border=2,
    )
    qr.add_data(data)
    qr.make(fit=True)
    buffer = io.StringIO()
    qr.print_ascii(out=buffer, invert=True)
    return buffer.getvalue().strip("\n")


def iter_lines(data: str) -> Iterable[str]:
    """Yield the rendered lines lazily."""
    for line in render_text(data).splitlines():
        yield line
