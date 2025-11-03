"""
Configuration helpers for locating persistent storage and secrets.
"""

from __future__ import annotations

import json
import os
import platform
from pathlib import Path
from typing import Any

APP_NAME = "local_control"


def data_dir() -> Path:
    """
    Return the directory used to persist trusted device metadata.
    The directory is created lazily when first accessed.
    """
    system = platform.system()
    if system == "Windows":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    elif system == "Darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))

    target = base / APP_NAME
    target.mkdir(parents=True, exist_ok=True)
    return target


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def save_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".tmp")
    tmp_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp_path.replace(path)
