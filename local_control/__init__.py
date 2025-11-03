"""
Local Control package exposing the web server and CLI helpers.
"""

from __future__ import annotations

__all__ = ["create_app", "__version__"]

__version__ = "0.1.0"

from .app import create_app  # noqa: E402  (lazy import to avoid side effects)
