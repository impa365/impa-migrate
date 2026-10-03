"""IMPA Migrate — System Information & Local Health Diagnostics."""
from __future__ import annotations

import os
import platform
import re
import shutil
import socket
import subprocess
import urllib.request
from pathlib import Path
from typing import Any


def _read_os_release() -> dict[str, str]:
    data: dict[str, str] = {}
    path = Path("/etc/os-release")
    if not path.exists():
        return data
    try:
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                data[k.strip()] = v.strip().strip('"')
    except Exception:
        pass
    return data


def get_public_ip() -> str:
    env = os.environ.get("MIGRATOR_PUBLIC_IP", "").strip() or os.environ.get("SETUPIMPA_PUBLIC_IP", "").strip()
    if env:
        return env
    p_ip = Path("/root/dados_vps/public_ip")
    if p_ip.exists():
        try:
            val = p_ip.read_text(encoding="utf-8").strip()
            if re.match(r"^\d+\.\d+\.\d+\.\d+$", val):
                return val
        except Exception:
            pass

    for url in ("https://ifconfig.me/ip", "https://icanhazip.com", "https://api.ipify.org"):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "curl/7.68.0"})
            with urllib.request.urlopen(req, timeout=3) as resp:
                out = resp.read().decode("utf-8").strip()
                if re.match(r"^\d+\.\d+\.\d+\.\d+$", out):
                    return out
        except Exception:
            continue
    try:
        return socket.gethostbyname(socket.gethostname())
    except Exception:
        return "127.0.0.1"


def get_system_metrics() -> dict[str, Any]:
    """Retrieve CPU, RAM, and Disk metrics."""
    # RAM
    ram_total_mb = 0
    ram_free_mb = 0
    ram_used_mb = 0
    ram_pct = 0.0
    meminfo = Path("/proc/meminfo")
    if meminfo.exists():
        try:
            vals: dict[str, int] = {}
            for line in meminfo.read_text(encoding="utf-8", errors="replace").splitlines():
                parts = line.split(":")
                if len(parts) == 2:
                    k = parts[0].strip()
                    num = re.findall(r"\d+", parts[1])
                    if num:
                        vals[k] = int(num[0])
            total_kb = vals.get("MemTotal", 0)
            avail_kb = vals.get("MemAvailable", vals.get("MemFree", 0))
            used_kb = max(0, total_kb - avail_kb)
            ram_total_mb = round(total_kb / 1024, 1)
            ram_used_mb = round(used_kb / 1024, 1)
            ram_free_mb = round(avail_kb / 1024, 1)
            ram_pct = round((used_kb / total_kb * 100), 1) if total_kb > 0 else 0.0
        except Exception:
            pass

    # Disk /
    disk_total_gb = 0.0
    disk_free_gb = 0.0
    disk_used_gb = 0.0
    disk_pct = 0.0
    try:
        total, used, free = shutil.disk_usage("/")
        disk_total_gb = round(total / (1024**3), 2)
        disk_used_gb = round(used / (1024**3), 2)
        disk_free_gb = round(free / (1024**3), 2)
        disk_pct = round((used / total * 100), 1) if total > 0 else 0.0
    except Exception:
        pass

    # CPU cores
    cpu_cores = os.cpu_count() or 1

    return {
        "ram_total_mb": ram_total_mb,
        "ram_used_mb": ram_used_mb,
        "ram_free_mb": ram_free_mb,
        "ram_percent": ram_pct,
        "disk_total_gb": disk_total_gb,
        "disk_used_gb": disk_used_gb,
        "disk_free_gb": disk_free_gb,
        "disk_percent": disk_pct,
        "cpu_cores": cpu_cores,
    }


def get_docker_and_swarm_info() -> dict[str, Any]:
    """Inspect local Docker daemon and Swarm status."""
    docker_bin = shutil.which("docker") or "/usr/bin/docker"
    has_docker = bool(shutil.which("docker") or Path("/usr/bin/docker").exists() or Path("/var/run/docker.sock").exists())
    docker_version = ""
    swarm_active = False
    swarm_role = "inactive"
    containers_count = 0
    images_count = 0

    if has_docker:
        try:
            r = subprocess.run(
                [docker_bin, "info", "--format", "{{.ServerVersion}}|{{.Swarm.LocalNodeState}}|{{.Swarm.ControlAvailable}}|{{.Containers}}|{{.Images}}"],
                capture_output=True, text=True, timeout=5, check=False,
            )
            if r.returncode == 0 and r.stdout.strip():
                parts = r.stdout.strip().split("|")
                if len(parts) >= 5:
                    docker_version = parts[0]
                    state = parts[1].lower()
                    ctrl = parts[2].lower() == "true"
                    swarm_active = state == "active"
                    swarm_role = "manager" if ctrl else ("worker" if swarm_active else "inactive")
                    try:
                        containers_count = int(parts[3])
                        images_count = int(parts[4])
                    except ValueError:
                        pass
        except Exception:
            pass

    return {
        "docker_installed": has_docker,
        "docker_version": docker_version,
        "swarm_active": swarm_active,
        "swarm_role": swarm_role,
        "containers_count": containers_count,
        "images_count": images_count,
    }


def get_full_system_info() -> dict[str, Any]:
    """Aggregate system, OS, metrics and Docker info."""
    os_info = _read_os_release()
    os_name = os_info.get("PRETTY_NAME", os_info.get("NAME", platform.system()))
    os_version = os_info.get("VERSION_ID", platform.release())
    arch = platform.machine()
    pub_ip = get_public_ip()
    metrics = get_system_metrics()
    docker_info = get_docker_and_swarm_info()

    return {
        "os_name": os_name,
        "os_version": os_version,
        "arch": arch,
        "public_ip": pub_ip,
        "hostname": socket.gethostname(),
        "metrics": metrics,
        "docker": docker_info,
    }
