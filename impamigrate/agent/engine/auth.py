"""IMPA Migrate — Authentication & Token management."""
from __future__ import annotations

import json
import logging
import os
import secrets
import time
from pathlib import Path
from typing import Any

log = logging.getLogger("impamigrate.auth")

DADOS = Path("/root/dados_vps")
TOKEN_FILE = DADOS / "migrator_auth.json"
LOCAL_TOKEN_FILE = Path("/opt/impamigrate/auth.json")


def _get_storage_path() -> Path:
    if DADOS.exists():
        return TOKEN_FILE
    return LOCAL_TOKEN_FILE


def get_or_create_token() -> str:
    """Return persistent admin token, generating one if missing."""
    env_token = os.environ.get("MIGRATOR_TOKEN", "").strip()
    if env_token:
        return env_token

    storage = _get_storage_path()
    if storage.exists():
        try:
            data = json.loads(storage.read_text(encoding="utf-8"))
            token = data.get("token")
            if token and len(token) >= 16:
                return token
        except Exception as e:
            log.warning("Failed to read token file: %s", e)

    new_token = f"migrator_{secrets.token_urlsafe(32)}"
    save_token(new_token)
    return new_token


def save_token(token: str) -> None:
    storage = _get_storage_path()
    storage.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "token": token.strip(),
        "created_at": int(time.time()),
        "role": "admin",
    }
    storage.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    try:
        storage.chmod(0o600)
    except Exception:
        pass


def validate_token(token: str | None) -> dict[str, Any] | None:
    """Validate bearer token against active token."""
    if not token:
        return None
    token = token.strip()
    if token.lower().startswith("bearer "):
        token = token[7:].strip()

    active_token = get_or_create_token()
    if secrets.compare_digest(token, active_token):
        return {"authenticated": True, "user": "admin", "role": "admin"}

    env_token = os.environ.get("MIGRATOR_TOKEN", "").strip()
    if env_token and secrets.compare_digest(token, env_token):
        return {"authenticated": True, "user": "root_env", "role": "admin"}

    return None
