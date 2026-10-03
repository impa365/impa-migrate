"""IMPA Migrate Agent — Dedicated FastAPI backend for Server Migration."""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from engine import auth, cloudflare, destination, discovery, orchestrator, system_info

VERSION = os.environ.get("IMPA_MIGRATOR_VERSION", "1.2.0")
STATIC = Path(__file__).resolve().parent / "static"
LOG_FILE = Path("/var/log/impa-migrator.log")

_handlers = [logging.StreamHandler()]
if os.name != "nt":
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        _handlers.append(logging.FileHandler(str(LOG_FILE), encoding="utf-8"))
    except Exception:
        pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=_handlers,
)
log = logging.getLogger("impamigrate")

app = FastAPI(title="IMPA Migrate Panel", version=VERSION)


def _extract_bearer(authorization: str | None = None, x_token: str | None = None, token_param: str | None = None) -> str:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization.split(" ", 1)[1].strip()
    if x_token:
        return x_token.strip()
    if token_param:
        return token_param.strip()
    return ""


def require_auth(
    authorization: str | None = Header(default=None),
    x_migrator_token: str | None = Header(default=None),
    token: str | None = Query(default=None),
):
    extracted = _extract_bearer(authorization, x_migrator_token, token)
    sess = auth.validate_token(extracted)
    if not sess:
        raise HTTPException(status_code=401, detail="nao_autenticado")
    return sess


# ── Schemas ──────────────────────────────────────────────────────────

class PortainerVerifyBody(BaseModel):
    url: str = ""
    user: str = "admin"
    password: str = ""


class TestSshBody(BaseModel):
    host: str
    port: int = 22
    username: str = "root"
    password: str | None = None
    private_key: str | None = None


class DestinationPreflightBody(BaseModel):
    host: str
    port: int = 22
    username: str = "root"
    password: str | None = None
    private_key: str | None = None
    origin_arch: str = "x86_64"
    required_bytes: int = 0


class StartMigrationBody(BaseModel):
    dest_ip: str
    dest_port: int = 22
    dest_user: str = "root"
    dest_password: str | None = None
    dest_private_key: str | None = None
    selected_stacks: list[str] = Field(default_factory=list)
    selected_volumes: list[str] = Field(default_factory=list)
    mode: str = "cutover"  # cutover | test
    rate_limit_mb: int = 0


class CloudflareTokenBody(BaseModel):
    token: str


class CloudflareCutoverBody(BaseModel):
    domains: list[str] = Field(default_factory=list)
    dest_ip: str


# ── Health & Auth Endpoints ──────────────────────────────────────────

@app.get("/api/health")
def health():
    return {"ok": True, "version": VERSION, "name": "IMPA Migrate"}


@app.get("/api/auth/status")
def auth_status(
    authorization: str | None = Header(default=None),
    x_migrator_token: str | None = Header(default=None),
    token: str | None = Query(default=None),
):
    extracted = _extract_bearer(authorization, x_migrator_token, token)
    valid = bool(auth.validate_token(extracted))
    return {
        "ok": True,
        "authenticated": valid,
        "token": auth.get_or_create_token(),
        "version": VERSION,
    }


# ── Discovery & Origin Endpoints ────────────────────────────────────

@app.get("/api/origin/system")
def get_origin_system(_: dict = Depends(require_auth)):
    """Retrieve local origin server OS, CPU, RAM and Docker Swarm info."""
    return system_info.get_full_system_info()


@app.post("/api/origin/scan")
def scan_origin(body: PortainerVerifyBody | None = None, _: dict = Depends(require_auth)):
    """Execute complete discovery scan of Swarm stacks, Portainer, volumes, and sizes."""
    p_user = body.user if body else ""
    p_pass = body.password if body else ""
    return discovery.run_full_discovery(portainer_user=p_user, portainer_pass=p_pass)


@app.post("/api/origin/portainer/verify")
def verify_portainer(body: PortainerVerifyBody, _: dict = Depends(require_auth)):
    """Validate Portainer credentials and list its stacks."""
    url = body.url.strip() or "http://127.0.0.1:9000"
    res = discovery.verify_portainer_api(url, body.user, body.password)
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error", "falha_login_portainer"))
    stacks = discovery.list_portainer_stacks(res["api_base"], res["token"])
    return {
        "ok": True,
        "token": res["token"],
        "api_base": res["api_base"],
        "stacks": stacks,
    }


# ── Destination Endpoints ───────────────────────────────────────────

@app.post("/api/destination/test-ssh")
def test_destination_ssh(body: TestSshBody, _: dict = Depends(require_auth)):
    """Test SSH reachability and authentication to destination VPS."""
    res = destination.test_ssh_connection(
        host=body.host,
        port=body.port,
        username=body.username,
        password=body.password,
        private_key=body.private_key,
    )
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error", "falha_ssh"))
    return res


@app.post("/api/destination/preflight")
def run_preflight(body: DestinationPreflightBody, _: dict = Depends(require_auth)):
    """Audit destination VPS for OS, arch, disk space, and clean environment."""
    res = destination.run_destination_preflight(
        host=body.host,
        port=body.port,
        username=body.username,
        password=body.password,
        private_key=body.private_key,
        origin_arch=body.origin_arch,
        required_bytes=body.required_bytes,
    )
    return res


# ── Migration Execution Endpoints ───────────────────────────────────

@app.post("/api/migration/start")
def start_migration(body: StartMigrationBody, _: dict = Depends(require_auth)):
    """Launch background migration task."""
    res = orchestrator.start_migration(body.model_dump())
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error", "falha_iniciar_migracao"))
    return res


@app.get("/api/migration/status")
def migration_status(_: dict = Depends(require_auth)):
    """Retrieve real-time migration progress, volume streaming, and logs."""
    job = orchestrator.get_active_job()
    if not job:
        return {"status": "idle", "message": "Nenhuma migração em andamento"}
    return job.to_dict()


@app.post("/api/migration/cancel")
def cancel_migration(_: dict = Depends(require_auth)):
    """Request clean abort of active migration."""
    return orchestrator.cancel_active_migration()


# ── Cloudflare DNS Endpoints ────────────────────────────────────────

@app.get("/api/cloudflare/status")
def get_cf_status(_: dict = Depends(require_auth)):
    token = cloudflare.get_token()
    if not token:
        return {"ok": False, "configured": False, "message": "Token não configurado"}
    verify = cloudflare.verify_token(token)
    return {**verify, "configured": True}


@app.post("/api/cloudflare/token")
def save_cf_token(body: CloudflareTokenBody, _: dict = Depends(require_auth)):
    token = body.token.strip()
    if not token:
        raise HTTPException(status_code=400, detail="Token vazio")
    verify = cloudflare.verify_token(token)
    if not verify.get("ok"):
        raise HTTPException(status_code=400, detail=verify.get("error", "Token inválido"))
    cloudflare.save_token(token)
    return {"ok": True, "message": "Token Cloudflare salvo com sucesso!"}


@app.post("/api/cloudflare/detect-domains")
def detect_domains(stacks: list[dict[str, Any]], _: dict = Depends(require_auth)):
    """Extract all domains used in Traefik router rules."""
    domains = cloudflare.extract_domains_from_stacks(stacks)
    return {"ok": True, "domains": domains, "count": len(domains)}


@app.post("/api/cloudflare/cutover")
def switch_dns(body: CloudflareCutoverBody, _: dict = Depends(require_auth)):
    """Switch DNS A records of all detected domains to the new destination IP."""
    token = cloudflare.get_token()
    if not token:
        raise HTTPException(status_code=400, detail="Token da Cloudflare não configurado")
    res = cloudflare.execute_dns_cutover(body.domains, body.dest_ip, token)
    return res


@app.post("/api/cloudflare/rollback")
def rollback_dns(_: dict = Depends(require_auth)):
    """Rollback DNS records to the previous snapshot."""
    token = cloudflare.get_token()
    if not token:
        raise HTTPException(status_code=400, detail="Token da Cloudflare não configurado")
    return cloudflare.execute_dns_rollback(token)


# ── Static SPA Serving ──────────────────────────────────────────────

if (STATIC / "assets").exists():
    app.mount("/assets", StaticFiles(directory=str(STATIC / "assets")), name="assets")


@app.get("/")
def index():
    index_path = STATIC / "index.html"
    if index_path.exists():
        return FileResponse(index_path, headers={"Cache-Control": "no-cache, no-store, must-revalidate"})
    return {"message": "IMPA Migrate agent online", "version": VERSION}
