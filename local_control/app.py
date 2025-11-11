"""
Flask application wiring the authentication manager, control handlers,
and static frontend.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple

from flask import (
    Flask,
    Response,
    jsonify,
    make_response,
    request,
    send_from_directory,
)

from .auth import AuthManager, CredentialError, RateLimitError
from . import control, clipboard
from .clipboard import ClipboardData

SESSION_COOKIE = "session_token"
TRUSTED_COOKIE = "trusted_token"
SESSION_MAX_AGE = 60 * 60 * 4  # 4 hours
TRUSTED_MAX_AGE = 60 * 60 * 24 * 30  # 30 days

LOG = logging.getLogger(__name__)


def create_app(auth_manager: Optional[AuthManager] = None) -> Flask:
    static_dir = Path(__file__).parent / "static"
    app = Flask(
        __name__,
        static_folder=str(static_dir),
        static_url_path="/static",
    )
    app.config["JSONIFY_PRETTYPRINT_REGULAR"] = False
    auth = auth_manager or AuthManager()

    def client_key() -> str:
        return request.remote_addr or "unknown"

    def ensure_session() -> Tuple[Optional[str], Optional[str]]:
        token = request.cookies.get(SESSION_COOKIE)
        user = auth.session_user(token)
        if user:
            return user, None

        trusted = request.cookies.get(TRUSTED_COOKIE)
        user = auth.auto_login(trusted)
        if user:
            fresh = auth.create_session(user)
            return user, fresh
        return None, None

    def require_auth() -> Tuple[Optional[str], Optional[str]]:
        user, new_token = ensure_session()
        if not user:
            return None, None
        return user, new_token

    def build_response(
        payload: Dict[str, Any],
        session_token: Optional[str] = None,
        clear_session: bool = False,
        trusted_token: Optional[str] = None,
        clear_trusted: bool = False,
        status: int = 200,
    ) -> Response:
        response = make_response(jsonify(payload), status)
        if session_token:
            response.set_cookie(
                SESSION_COOKIE,
                session_token,
                httponly=True,
                secure=False,
                samesite="Strict",
                max_age=SESSION_MAX_AGE,
            )
        if clear_session:
            response.delete_cookie(SESSION_COOKIE)
        if trusted_token:
            response.set_cookie(
                TRUSTED_COOKIE,
                trusted_token,
                httponly=True,
                secure=False,
                samesite="Strict",
                max_age=TRUSTED_MAX_AGE,
            )
        if clear_trusted:
            response.delete_cookie(TRUSTED_COOKIE)
        return response

    # Routes -----------------------------------------------------------------
    @app.get("/")
    def index() -> Response:
        return send_from_directory(app.static_folder, "index.html")

    @app.get("/api/session")
    def session_info() -> Response:
        user, fresh_token = ensure_session()
        if user:
            return build_response(
                {"authenticated": True, "username": user},
                session_token=fresh_token,
            )
        return build_response({"authenticated": False, "username": None})

    @app.post("/api/login")
    def login() -> Response:
        data = request.get_json(silent=True) or {}
        username = str(data.get("username", "")).strip()
        password = str(data.get("password", ""))
        remember = bool(data.get("remember", False))
        remote = client_key()

        try:
            auth.check_rate_limit(remote)
        except RateLimitError as exc:
            return build_response({"error": str(exc)}, status=429)

        try:
            verified = auth.verify_credentials(username, password)
        except CredentialError as exc:
            LOG.warning("Credential verification error: %s", exc)
            return build_response({"error": str(exc)}, status=400)

        if not verified:
            auth.register_failure(remote)
            return build_response({"error": "Invalid username or password."}, status=401)

        auth.register_success(remote)
        session_token = auth.create_session(username)
        trusted_token = auth.create_trusted_token(username) if remember else None

        payload = {"authenticated": True, "username": username}
        return build_response(
            payload,
            session_token=session_token,
            trusted_token=trusted_token,
        )

    @app.post("/api/logout")
    def logout() -> Response:
        token = request.cookies.get(SESSION_COOKIE)
        if token:
            auth.destroy_session(token)
        return build_response({"authenticated": False}, clear_session=True)

    def auth_endpoint(handler: Callable[[Dict[str, Any]], Dict[str, Any]]) -> Response:
        user, fresh_token = require_auth()
        if not user:
            return build_response({"error": "Authentication required."}, status=401)
        payload = request.get_json(silent=True) or {}
        try:
            response_payload = handler(payload)
        except ValueError as exc:
            return build_response({"error": str(exc)}, status=400)
        except Exception as exc:  # pragma: no cover - defensive
            LOG.exception("Handler error: %s", exc)
            return build_response({"error": str(exc)}, status=500)
        return build_response(response_payload, session_token=fresh_token)

    @app.post("/api/mouse/move")
    def mouse_move() -> Response:
        def action(data: Dict[str, Any]) -> Dict[str, Any]:
            dx = float(data.get("dx", 0.0))
            dy = float(data.get("dy", 0.0))
            state = control.move_cursor(dx, dy)
            return {"status": "ok", "state": state}

        return auth_endpoint(action)

    @app.post("/api/mouse/click")
    def mouse_click() -> Response:
        def action(data: Dict[str, Any]) -> Dict[str, Any]:
            button = str(data.get("button", "left"))
            double = bool(data.get("double", False))
            control.click(button=button, double=double)
            return {"status": "ok"}

        return auth_endpoint(action)

    @app.post("/api/mouse/button")
    def mouse_button() -> Response:
        def action(data: Dict[str, Any]) -> Dict[str, Any]:
            button = str(data.get("button", "left"))
            button_action = str(data.get("action", "down"))
            control.button_action(button=button, action=button_action)
            return {"status": "ok"}

        return auth_endpoint(action)

    @app.post("/api/mouse/scroll")
    def mouse_scroll() -> Response:
        def action(data: Dict[str, Any]) -> Dict[str, Any]:
            vertical = float(data.get("vertical", 0.0))
            horizontal = float(data.get("horizontal", 0.0))
            control.scroll(vertical=vertical, horizontal=horizontal)
            return {"status": "ok"}

        return auth_endpoint(action)

    @app.get("/api/mouse/state")
    def mouse_state() -> Response:
        user, fresh_token = require_auth()
        if not user:
            return build_response({"error": "Authentication required."}, status=401)
        state = control.cursor_state()
        return build_response({"status": "ok", "state": state}, session_token=fresh_token)

    @app.post("/api/keyboard/type")
    def keyboard_type() -> Response:
        def action(data: Dict[str, Any]) -> Dict[str, Any]:
            text = str(data.get("text", ""))
            control.type_text(text)
            return {"status": "ok"}

        return auth_endpoint(action)

    @app.post("/api/keyboard/key")
    def keyboard_key() -> Response:
        def action(data: Dict[str, Any]) -> Dict[str, Any]:
            key = str(data.get("key", "")).lower()
            action_name = str(data.get("action", "press")).lower()
            control.key_action(key, action_name)
            return {"status": "ok"}

        return auth_endpoint(action)

    @app.post("/api/system/lock")
    def system_lock() -> Response:
        def action(_: Dict[str, Any]) -> Dict[str, Any]:
            control.lock_screen()
            return {"status": "ok"}

        return auth_endpoint(action)

    @app.post("/api/system/unlock")
    def system_unlock() -> Response:
        def action(_: Dict[str, Any]) -> Dict[str, Any]:
            control.unlock_screen()
            return {"status": "ok"}

        return auth_endpoint(action)

    @app.post("/api/system/shutdown")
    def system_shutdown() -> Response:
        def action(_: Dict[str, Any]) -> Dict[str, Any]:
            control.shutdown_system()
            return {"status": "ok"}

        return auth_endpoint(action)

    @app.get("/api/clipboard")
    def clipboard_read() -> Response:
        user, fresh_token = require_auth()
        if not user:
            return build_response({"error": "Authentication required."}, status=401)
        clip = clipboard.get_clipboard()
        if clip:
            content = {"type": clip.kind, "data": clip.data, "mime": clip.mime}
        else:
            content = None
        return build_response(
            {"status": "ok", "content": content},
            session_token=fresh_token,
        )

    @app.post("/api/clipboard")
    def clipboard_write() -> Response:
        def action(data: Dict[str, Any]) -> Dict[str, Any]:
            clip_type = str(data.get("type", "")).lower()
            if clip_type not in {"text", "image"}:
                raise ValueError("Clipboard type must be 'text' or 'image'.")
            payload = data.get("data")
            if payload is None:
                raise ValueError("Clipboard payload missing.")
            mime = data.get("mime")
            clip = ClipboardData(kind=clip_type, data=str(payload), mime=str(mime) if mime else None)
            clipboard.set_clipboard(clip)
            return {"status": "ok"}

        return auth_endpoint(action)

    return app
