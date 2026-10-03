"""IMPA Migrate — Origin Server Discovery Engine.
Scans Swarm stacks, Portainer, Docker volumes, disk sizes, networks, and configuration files.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import httpx

from engine import system_info

log = logging.getLogger("impamigrate.discovery")
DADOS = Path("/root/dados_vps")


def _run_cmd(cmd: list[str], timeout: int = 15) -> str:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
        return r.stdout.strip()
    except Exception as e:
        log.warning("Command failed %s: %s", cmd, e)
        return ""


def detect_portainer_info() -> dict[str, Any]:
    """Detect if Portainer is installed, its container, URL and credentials if saved."""
    docker_bin = shutil.which("docker") or "/usr/bin/docker"
    output = _run_cmd([docker_bin, "ps", "--filter", "name=portainer", "--format", "{{.ID}}|{{.Names}}|{{.Ports}}|{{.Image}}"])
    found = False
    container_name = ""
    container_id = ""
    port = "9000"
    url = ""
    user = "admin"
    password = ""
    has_saved_creds = False

    if output:
        found = True
        parts = output.splitlines()[0].split("|")
        container_id = parts[0] if len(parts) > 0 else ""
        container_name = parts[1] if len(parts) > 1 else "portainer"

    # Check dados_vps / dados_portainer
    dp = DADOS / "dados_portainer"
    if dp.exists():
        try:
            for line in dp.read_text(encoding="utf-8", errors="replace").splitlines():
                if "PORTAINER_URL=" in line:
                    url = line.split("PORTAINER_URL=", 1)[1].strip()
                elif "PORTAINER_USER=" in line:
                    user = line.split("PORTAINER_USER=", 1)[1].strip()
                elif "PORTAINER_PASS=" in line:
                    password = line.split("PORTAINER_PASS=", 1)[1].strip()
            if user and password:
                has_saved_creds = True
        except Exception:
            pass

    # Check Traefik domain for portainer
    if not url:
        p_dom = DADOS / "portainer_domain.txt"
        if p_dom.exists():
            dom = p_dom.read_text(encoding="utf-8").strip()
            if dom:
                url = f"https://{dom}"

    if not url and found:
        pub_ip = system_info.get_public_ip()
        url = f"http://{pub_ip}:9000"

    return {
        "installed": found,
        "container_id": container_id,
        "container_name": container_name,
        "url": url,
        "user": user,
        "has_saved_creds": has_saved_creds,
        "saved_password": password if has_saved_creds else "",
    }


def verify_portainer_api(api_url: str, user: str, password: str) -> dict[str, Any]:
    """Test login against Portainer API and retrieve auth token."""
    clean_url = api_url.rstrip("/")
    # Attempt on /api/auth
    target = f"{clean_url}/api/auth"
    try:
        with httpx.Client(verify=False, timeout=8.0) as client:
            resp = client.post(target, json={"username": user, "password": password})
            if resp.status_code == 200:
                data = resp.json()
                token = data.get("jwt") or data.get("token") or ""
                return {"ok": True, "token": token, "api_base": clean_url}
            return {"ok": False, "error": f"Credenciais rejeitadas pelo Portainer (HTTP {resp.status_code})"}
    except Exception as e:
        # Retry localhost:9000 if domain or IP failed from inside
        if "127.0.0.1" not in clean_url and "localhost" not in clean_url:
            try:
                fallback = "http://127.0.0.1:9000"
                with httpx.Client(verify=False, timeout=5.0) as client:
                    resp = client.post(f"{fallback}/api/auth", json={"username": user, "password": password})
                    if resp.status_code == 200:
                        data = resp.json()
                        token = data.get("jwt") or data.get("token") or ""
                        return {"ok": True, "token": token, "api_base": fallback}
            except Exception:
                pass
        return {"ok": False, "error": f"Não foi possível conectar ao Portainer: {e}"}


def list_swarm_stacks_docker() -> list[dict[str, Any]]:
    """List stacks directly from docker stack ls."""
    docker_bin = shutil.which("docker") or "/usr/bin/docker"
    raw = _run_cmd([docker_bin, "stack", "ls", "--format", "{{.Name}}|{{.Services}}"])
    stacks: list[dict[str, Any]] = []
    if not raw:
        return stacks
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("|")
        name = parts[0]
        services_count = parts[1] if len(parts) > 1 else "1"
        stacks.append({
            "name": name,
            "services_count": services_count,
            "source": "docker_swarm",
            "active": True,
            "is_system": name.lower() in ("traefik", "portainer"),
        })
    return stacks


def list_portainer_stacks(api_base: str, token: str) -> list[dict[str, Any]]:
    """Fetch stacks and their compose file contents from Portainer API."""
    stacks: list[dict[str, Any]] = []
    headers = {"Authorization": f"Bearer {token}"}
    try:
        with httpx.Client(verify=False, timeout=10.0) as client:
            r = client.get(f"{api_base}/api/stacks", headers=headers)
            if r.status_code == 200:
                raw_stacks = r.json()
                for item in raw_stacks:
                    s_id = item.get("Id")
                    s_name = item.get("Name", "")
                    s_status = item.get("Status", 1)  # 1 = Active, 2 = Inactive
                    s_type = item.get("Type", 1)      # 1 = Swarm, 2 = Compose
                    entry_point = item.get("EntryPoint", "")

                    # Fetch file content
                    file_content = ""
                    try:
                        fr = client.get(f"{api_base}/api/stacks/{s_id}/file", headers=headers)
                        if fr.status_code == 200:
                            file_content = fr.json().get("StackFileContent", "")
                    except Exception:
                        pass

                    stacks.append({
                        "id": s_id,
                        "name": s_name,
                        "status": "active" if s_status == 1 else "inactive",
                        "active": s_status == 1,
                        "type": "swarm" if s_type == 1 else "compose",
                        "entry_point": entry_point,
                        "compose_content": file_content,
                        "is_system": s_name.lower() in ("traefik", "portainer"),
                        "source": "portainer_api",
                    })
    except Exception as e:
        log.warning("Failed to fetch Portainer stacks: %s", e)
    return stacks


def list_docker_volumes() -> list[dict[str, Any]]:
    """Inspect all Docker volumes, calculate their disk usage and associated containers."""
    docker_bin = shutil.which("docker") or "/usr/bin/docker"
    raw_vols = _run_cmd([docker_bin, "volume", "ls", "--format", "{{.Name}}|{{.Driver}}"])
    if not raw_vols:
        return []

    # Map container mounts
    mount_map: dict[str, list[str]] = {}
    inspect_raw = _run_cmd([docker_bin, "ps", "-a", "--format", "{{.Names}}|{{.Mounts}}"])
    for line in inspect_raw.splitlines():
        if "|" in line:
            c_name, mounts = line.split("|", 1)
            for m in mounts.split(","):
                m_clean = m.strip()
                if m_clean:
                    mount_map.setdefault(m_clean, []).append(c_name)

    vols: list[dict[str, Any]] = []
    volumes_dir = Path("/var/lib/docker/volumes")

    for line in raw_vols.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("|")
        name = parts[0]
        driver = parts[1] if len(parts) > 1 else "local"

        # Calculate disk size
        size_bytes = 0
        v_path = volumes_dir / name / "_data"
        if v_path.exists():
            du_out = _run_cmd(["du", "-sb", str(v_path)], timeout=5)
            if du_out:
                num = re.findall(r"^\d+", du_out)
                if num:
                    size_bytes = int(num[0])

        size_mb = round(size_bytes / (1024 * 1024), 2)
        size_gb = round(size_bytes / (1024 * 1024 * 1024), 3)

        vols.append({
            "name": name,
            "driver": driver,
            "size_bytes": size_bytes,
            "size_mb": size_mb,
            "size_gb": size_gb,
            "size_human": f"{size_gb} GB" if size_gb >= 1.0 else f"{size_mb} MB",
            "containers": mount_map.get(name, []),
            "is_system": any(sys_kw in name.lower() for sys_kw in ("portainer", "traefik")),
        })

    # Sort by size descending
    vols.sort(key=lambda x: x["size_bytes"], reverse=True)
    return vols


def list_docker_networks() -> list[dict[str, Any]]:
    """List Docker networks (bridge and overlay)."""
    docker_bin = shutil.which("docker") or "/usr/bin/docker"
    raw = _run_cmd([docker_bin, "network", "ls", "--format", "{{.ID}}|{{.Name}}|{{.Driver}}|{{.Scope}}"])
    nets: list[dict[str, Any]] = []
    if not raw:
        return nets
    for line in raw.splitlines():
        parts = line.strip().split("|")
        if len(parts) >= 4:
            name = parts[1]
            driver = parts[2]
            scope = parts[3]
            # Exclude standard built-in defaults
            if name not in ("bridge", "host", "none", "ingress", "docker_gwbridge"):
                nets.append({
                    "id": parts[0],
                    "name": name,
                    "driver": driver,
                    "scope": scope,
                })
    return nets


def list_root_files() -> list[dict[str, Any]]:
    """Find YAML stacks and configuration files in /root and /root/dados_vps."""
    root_path = Path("/root")
    found_files: list[dict[str, Any]] = []
    if not root_path.exists():
        return found_files

    try:
        # Search YAMLs in /root
        for p in root_path.glob("*.y*ml"):
            try:
                found_files.append({
                    "path": str(p),
                    "filename": p.name,
                    "size_bytes": p.stat().st_size,
                    "type": "yaml",
                })
            except Exception:
                pass

        # Check /root/dados_vps
        dados_dir = root_path / "dados_vps"
        if dados_dir.exists():
            for p in dados_dir.rglob("*"):
                if p.is_file():
                    try:
                        found_files.append({
                            "path": str(p),
                            "filename": str(p.relative_to(root_path)),
                            "size_bytes": p.stat().st_size,
                            "type": "config",
                        })
                    except Exception:
                        pass
    except Exception as e:
        log.warning("Error reading /root files: %s", e)

    return found_files


def run_full_discovery(portainer_user: str = "", portainer_pass: str = "") -> dict[str, Any]:
    """Execute complete discovery scan of origin VPS."""
    sys_info = system_info.get_full_system_info()
    portainer = detect_portainer_info()

    # If credentials supplied or saved, test Portainer API
    p_user = portainer_user or portainer.get("user", "admin")
    p_pass = portainer_pass or portainer.get("saved_password", "")
    portainer_api_ok = False
    portainer_token = ""
    portainer_api_base = ""

    if portainer.get("installed") and p_pass:
        verify_res = verify_portainer_api(portainer.get("url", "http://127.0.0.1:9000"), p_user, p_pass)
        if verify_res.get("ok"):
            portainer_api_ok = True
            portainer_token = verify_res.get("token", "")
            portainer_api_base = verify_res.get("api_base", "")

    # Retrieve stacks: prefer Portainer API, fallback/augment with Docker Swarm stacks
    portainer_stacks: list[dict[str, Any]] = []
    if portainer_api_ok and portainer_token:
        portainer_stacks = list_portainer_stacks(portainer_api_base, portainer_token)

    swarm_stacks = list_swarm_stacks_docker()

    # Consolidate stacks list
    consolidated_stacks: list[dict[str, Any]] = []
    seen_names = set()

    for s in portainer_stacks:
        seen_names.add(s["name"].lower())
        consolidated_stacks.append(s)

    for s in swarm_stacks:
        if s["name"].lower() not in seen_names:
            consolidated_stacks.append(s)

    volumes = list_docker_volumes()
    networks = list_docker_networks()
    root_files = list_root_files()

    total_volume_bytes = sum(v["size_bytes"] for v in volumes)
    total_root_bytes = sum(f["size_bytes"] for f in root_files)
    total_bytes = total_volume_bytes + total_root_bytes

    total_gb = round(total_bytes / (1024**3), 2)
    total_mb = round(total_bytes / (1024**2), 1)
    total_human = f"{total_gb} GB" if total_gb >= 1.0 else f"{total_mb} MB"

    # Estimate time at typical VPS-to-VPS network speed (average 20 MB/s)
    speed_mb_s = 20.0
    estimated_seconds = int(total_mb / speed_mb_s) if total_mb > 0 else 10
    estimated_min = max(1, round(estimated_seconds / 60))

    return {
        "ok": True,
        "system": sys_info,
        "portainer": {
            **portainer,
            "api_verified": portainer_api_ok,
            "api_base": portainer_api_base,
            "token": portainer_token,
        },
        "stacks": consolidated_stacks,
        "stacks_count": len(consolidated_stacks),
        "volumes": volumes,
        "volumes_count": len(volumes),
        "networks": networks,
        "networks_count": len(networks),
        "root_files": root_files,
        "totals": {
            "volume_bytes": total_volume_bytes,
            "root_bytes": total_root_bytes,
            "total_bytes": total_bytes,
            "total_mb": total_mb,
            "total_gb": total_gb,
            "total_human": total_human,
            "estimated_minutes": estimated_min,
        },
    }
