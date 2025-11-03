"""
Authentication manager handling OS credential checks, sessions, device trust,
and brute-force protections.
"""

from __future__ import annotations

import getpass
import hashlib
import secrets
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

from .config import data_dir, load_json, save_json


class RateLimitError(Exception):
    """Raised when a client exceeds the allowed login attempts."""


class CredentialError(Exception):
    """Raised when provided credentials cannot be validated."""


@dataclass
class Session:
    username: str
    created_at: float


@dataclass
class TrustedDevice:
    username: str
    token_hash: str
    created_at: float


class AuthManager:
    MAX_ATTEMPTS = 5
    WINDOW_SECONDS = 600
    LOCKOUT_SECONDS = 600

    def __init__(self) -> None:
        base = data_dir()
        self._secret_path = base / "secret.key"
        self._trusted_path = base / "trusted_devices.json"
        self._secret = self._load_secret()
        self._sessions: Dict[str, Session] = {}
        self._trusted_devices: List[TrustedDevice] = self._load_trusted_devices()
        self._attempts: Dict[str, Dict[str, float]] = {}
        self._current_user = getpass.getuser()

    @property
    def current_user(self) -> str:
        return self._current_user

    # Secret helpers ---------------------------------------------------------
    def _load_secret(self) -> bytes:
        if self._secret_path.exists():
            return self._secret_path.read_bytes()

        secret = secrets.token_bytes(32)
        self._secret_path.write_bytes(secret)
        return secret

    # Trusted device persistence ---------------------------------------------
    def _load_trusted_devices(self) -> List[TrustedDevice]:
        data = load_json(
            self._trusted_path,
            default={"devices": []},
        )
        devices: List[TrustedDevice] = []
        for entry in data.get("devices", []):
            try:
                devices.append(
                    TrustedDevice(
                        username=entry["username"],
                        token_hash=entry["token_hash"],
                        created_at=float(entry.get("created_at", 0.0)),
                    )
                )
            except KeyError:
                continue
        return devices

    def _persist_trusted(self) -> None:
        payload = {
            "devices": [
                {
                    "username": device.username,
                    "token_hash": device.token_hash,
                    "created_at": device.created_at,
                }
                for device in self._trusted_devices
            ]
        }
        save_json(self._trusted_path, payload)

    # Rate limiting ----------------------------------------------------------
    def check_rate_limit(self, key: str) -> None:
        entry = self._attempts.get(key)
        now = time.time()
        if not entry:
            return

        locked_until = entry.get("locked_until", 0.0)
        if locked_until and locked_until > now:
            raise RateLimitError("Too many attempts. Retry later.")

        timestamps = entry.get("timestamps", [])
        # Drop attempts outside of the time window.
        timestamps = [ts for ts in timestamps if now - ts < self.WINDOW_SECONDS]
        entry["timestamps"] = timestamps
        if len(timestamps) >= self.MAX_ATTEMPTS:
            entry["locked_until"] = now + self.LOCKOUT_SECONDS
            raise RateLimitError("Too many attempts. Retry later.")

    def register_failure(self, key: str) -> None:
        now = time.time()
        entry = self._attempts.setdefault(
            key, {"timestamps": [], "locked_until": 0.0}
        )
        entry.setdefault("timestamps", []).append(now)
        # Enforce the window retention.
        entry["timestamps"] = [
            ts for ts in entry["timestamps"] if now - ts < self.WINDOW_SECONDS
        ]
        if len(entry["timestamps"]) >= self.MAX_ATTEMPTS:
            entry["locked_until"] = now + self.LOCKOUT_SECONDS

    def register_success(self, key: str) -> None:
        if key in self._attempts:
            del self._attempts[key]

    # Token helpers ----------------------------------------------------------
    def _hash_token(self, token: str) -> str:
        return hashlib.sha256(self._secret + token.encode("utf-8")).hexdigest()

    def create_session(self, username: str) -> str:
        token = secrets.token_urlsafe(32)
        token_hash = self._hash_token(token)
        self._sessions[token_hash] = Session(username=username, created_at=time.time())
        return token

    def destroy_session(self, token: str) -> None:
        token_hash = self._hash_token(token)
        self._sessions.pop(token_hash, None)

    def session_user(self, token: Optional[str]) -> Optional[str]:
        if not token:
            return None
        token_hash = self._hash_token(token)
        session = self._sessions.get(token_hash)
        if session:
            return session.username
        return None

    # Trusted devices --------------------------------------------------------
    def create_trusted_token(self, username: str) -> str:
        token = secrets.token_urlsafe(32)
        token_hash = self._hash_token(token)
        self._trusted_devices.append(
            TrustedDevice(username=username, token_hash=token_hash, created_at=time.time())
        )
        self._persist_trusted()
        return token

    def auto_login(self, token: Optional[str]) -> Optional[str]:
        if not token:
            return None
        token_hash = self._hash_token(token)
        for device in self._trusted_devices:
            if device.token_hash == token_hash and device.username == self._current_user:
                return device.username
        return None

    # Credential verification ------------------------------------------------
    def verify_credentials(self, username: str, password: str) -> bool:
        if username != self._current_user:
            return False

        system = sys.platform
        if system.startswith("win"):
            return self._verify_windows(username, password)
        return self._verify_unix(username, password)

    def _verify_unix(self, username: str, password: str) -> bool:
        # Use sudo in non-interactive mode. Requires the user to be part of sudoers.
        if not password:
            return False
        try:
            subprocess.run(
                ["sudo", "-k"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            proc = subprocess.run(
                ["sudo", "-S", "-p", "", "true"],
                input=f"{password}\n".encode("utf-8"),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                check=False,
                timeout=10,
            )
            return proc.returncode == 0
        except (OSError, subprocess.SubprocessError):
            raise CredentialError(
                "Could not verify credentials on this platform. Ensure sudo is available."
            )

    def _verify_windows(self, username: str, password: str) -> bool:
        if not password:
            return False
        try:
            import ctypes
            from ctypes import wintypes
        except ImportError as exc:  # pragma: no cover
            raise CredentialError("Windows credential APIs are unavailable.") from exc

        LOGON32_LOGON_INTERACTIVE = 2
        LOGON32_PROVIDER_DEFAULT = 0

        handle = wintypes.HANDLE()
        result = ctypes.windll.advapi32.LogonUserW(
            ctypes.c_wchar_p(username),
            ctypes.c_wchar_p(None),
            ctypes.c_wchar_p(password),
            LOGON32_LOGON_INTERACTIVE,
            LOGON32_PROVIDER_DEFAULT,
            ctypes.byref(handle),
        )
        if result:
            ctypes.windll.kernel32.CloseHandle(handle)
            return True
        return False
