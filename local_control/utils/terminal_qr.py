"""
Helpers for rendering QR codes as terminal-friendly ASCII art.
"""

from __future__ import annotations

from typing import Iterable

from . import qrcodegen

_DARK = "██"
_LIGHT = "  "


def render_text(data: str) -> str:
    """
    Render a QR code pointing to ``data`` using double-width ASCII blocks.
    Returns the multi-line string that can be printed directly.
    """
    qr = qrcodegen.QrCode.encode_text(data, qrcodegen.QrCode.Ecc.LOW)
    border = 2
    lines = []
    for y in range(-border, qr.size + border):
        row = []
        for x in range(-border, qr.size + border):
            row.append(_DARK if qr.get_module(x, y) else _LIGHT)
        lines.append("".join(row).rstrip())
    return "\n".join(lines)


def iter_lines(data: str) -> Iterable[str]:
    """Yield the rendered lines lazily."""
    for line in render_text(data).splitlines():
        yield line
