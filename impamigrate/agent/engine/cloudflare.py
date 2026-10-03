"""IMPA Migrate — Cloudflare DNS Automation (Cutover & 1-Click Rollback).
Discovers domains used in Traefik labels, updates DNS records to the new VPS, and provides rollback.
"""
from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

log = logging.getLogger("impamigrate.cloudflare")

CF_API = "https://api.cloudflare.com/client/v4"
DADOS = Path("/root/dados_vps")
CF_TOKEN_FILE = DADOS / "cloudflare_token"
LOCAL_CF_TOKEN_FILE = Path("/opt/impamigrate/cloudflare_token")
DNS_SNAPSHOT_FILE = DADOS / "migrator_dns_snapshot.json"


def _token_path() -> Path:
    if DADOS.exists():
        return CF_TOKEN_FILE
    return LOCAL_CF_TOKEN_FILE


def get_token() -> str:
    path = _token_path()
    if path.exists():
        return path.read_text(encoding="utf-8").strip()
    return os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()


def save_token(token: str) -> None:
    path = _token_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(token.strip() + "\n", encoding="utf-8")
    try:
        path.chmod(0o600)
    except Exception:
        pass


def _cf_request(method: str, path: str, token: str, body: dict | None = None) -> dict:
    url = f"{CF_API}{path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    data = json.dumps(body).encode("utf-8") if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        try:
            err_body = json.loads(e.read())
        except Exception:
            err_body = {"errors": [{"message": str(e)}]}
        return {"success": False, "errors": err_body.get("errors", [{"message": str(e)}])}
    except Exception as e:
        return {"success": False, "errors": [{"message": str(e)}]}


def verify_token(token: str) -> dict[str, Any]:
    """Check if token is active and has Zone:DNS:Edit scope."""
    res = _cf_request("GET", "/user/tokens/verify", token)
    if not (res.get("success") and res.get("result", {}).get("status") == "active"):
        errors = res.get("errors", [])
        msg = errors[0].get("message", "Token Cloudflare inválido") if errors else "Token inválido"
        return {"ok": False, "error": msg}

    zones_res = _cf_request("GET", "/zones?per_page=1", token)
    can_edit_dns = False
    if zones_res.get("success") and zones_res.get("result"):
        perms = zones_res["result"][0].get("permissions", [])
        can_edit_dns = "#dns_records:edit" in perms

    return {
        "ok": True,
        "status": "active",
        "can_edit_dns": can_edit_dns,
    }


def find_zone(domain: str, token: str) -> dict[str, Any]:
    """Find Cloudflare zone_id for candidate domains."""
    parts = domain.strip(".").split(".")
    for i in range(len(parts) - 1):
        candidate = ".".join(parts[i:])
        result = _cf_request("GET", f"/zones?name={candidate}&status=active", token)
        if result.get("success") and result.get("result"):
            zone = result["result"][0]
            return {"ok": True, "zone_id": zone["id"], "zone_name": zone["name"]}
    return {"ok": False, "error": f"Zona Cloudflare não encontrada para {domain}"}


def extract_domains_from_stacks(stacks: list[dict[str, Any]]) -> list[str]:
    """Extract host domains mentioned in Traefik router rules inside compose contents or files."""
    found: set[str] = set()
    pattern = re.compile(r"Host\(`([^`]+)`\)", re.IGNORECASE)

    for stack in stacks:
        content = stack.get("compose_content", "")
        for m in pattern.finditer(content):
            dom = m.group(1).strip().lower()
            if "." in dom and not dom.startswith("{") and not "$" in dom:
                found.add(dom)

    # Check /root/dados_vps/portainer_domain.txt or panel_domain.json
    for f in (DADOS / "portainer_domain.txt", DADOS / "panel_domain.json"):
        if f.exists():
            try:
                raw = f.read_text(encoding="utf-8")
                for m in re.findall(r"[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", raw):
                    if not m.endswith(".local") and not m.endswith(".internal"):
                        found.add(m.lower())
            except Exception:
                pass

    return sorted(list(found))


def create_or_update_dns(domain: str, target_ip: str, token: str, proxied: bool = False) -> dict[str, Any]:
    """Create or update DNS A record in Cloudflare."""
    clean_domain = domain.strip().lower()
    zone_res = find_zone(clean_domain, token)
    if not zone_res.get("ok"):
        return zone_res
    zone_id = zone_res["zone_id"]

    # Search existing records
    records_res = _cf_request("GET", f"/zones/{zone_id}/dns_records?name={clean_domain}&type=A", token)
    existing = records_res.get("result", [])

    body = {
        "type": "A",
        "name": clean_domain,
        "content": target_ip.strip(),
        "ttl": 1,
        "proxied": proxied,
        "comment": "Gerenciado pelo IMPA Migrate",
    }

    if existing:
        rec_id = existing[0]["id"]
        old_ip = existing[0].get("content", "")
        update_res = _cf_request("PUT", f"/zones/{zone_id}/dns_records/{rec_id}", token, body)
        if update_res.get("success"):
            return {"ok": True, "action": "updated", "domain": clean_domain, "old_ip": old_ip, "new_ip": target_ip, "record_id": rec_id}
        err = update_res.get("errors", [{}])[0].get("message", "Erro ao atualizar DNS")
        return {"ok": False, "error": err, "domain": clean_domain}
    else:
        create_res = _cf_request("POST", f"/zones/{zone_id}/dns_records", token, body)
        if create_res.get("success"):
            rec_id = create_res.get("result", {}).get("id", "")
            return {"ok": True, "action": "created", "domain": clean_domain, "new_ip": target_ip, "record_id": rec_id}
        err = create_res.get("errors", [{}])[0].get("message", "Erro ao criar DNS")
        return {"ok": False, "error": err, "domain": clean_domain}


def execute_dns_cutover(domains: list[str], dest_ip: str, token: str) -> dict[str, Any]:
    """Execute switch of all domains to destination IP with snapshot for rollback."""
    results = []
    snapshot = []

    for dom in domains:
        clean = dom.strip().lower()
        if not clean:
            continue
        res = create_or_update_dns(clean, dest_ip, token)
        results.append(res)
        if res.get("ok") and res.get("old_ip"):
            snapshot.append({
                "domain": clean,
                "original_ip": res["old_ip"],
                "record_id": res.get("record_id"),
            })

    if snapshot:
        try:
            DNS_SNAPSHOT_FILE.parent.mkdir(parents=True, exist_ok=True)
            DNS_SNAPSHOT_FILE.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
        except Exception:
            pass

    return {
        "ok": all(r.get("ok") for r in results),
        "results": results,
        "snapshot_saved": len(snapshot),
    }


def execute_dns_rollback(token: str) -> dict[str, Any]:
    """Rollback DNS records to original IP recorded in snapshot."""
    if not DNS_SNAPSHOT_FILE.exists():
        return {"ok": False, "error": "Nenhum snapshot de DNS anterior encontrado para rollback."}

    try:
        snapshot = json.loads(DNS_SNAPSHOT_FILE.read_text(encoding="utf-8"))
    except Exception as e:
        return {"ok": False, "error": f"Erro ao ler snapshot de rollback: {e}"}

    results = []
    for item in snapshot:
        dom = item.get("domain")
        orig_ip = item.get("original_ip")
        if dom and orig_ip:
            res = create_or_update_dns(dom, orig_ip, token)
            results.append(res)

    return {
        "ok": all(r.get("ok") for r in results),
        "results": results,
        "message": f"Rollback de {len(results)} domínios executado com sucesso!",
    }
