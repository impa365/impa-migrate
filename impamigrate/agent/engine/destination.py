"""IMPA Migrate — Destination Server Preflight & Remote Execution Engine via SSH."""
from __future__ import annotations

import io
import logging
import re
import socket
import time
from typing import Any

import paramiko

log = logging.getLogger("impamigrate.destination")


def create_ssh_client(
    host: str,
    port: int = 22,
    username: str = "root",
    password: str | None = None,
    private_key: str | None = None,
    timeout: float = 12.0,
) -> paramiko.SSHClient:
    """Create and return an authenticated paramiko SSHClient."""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    pkey = None
    if private_key and private_key.strip():
        # Try RSA, Ed25519, ECDSA
        key_str = private_key.strip()
        key_file = io.StringIO(key_str)
        for key_cls in (paramiko.RSAKey, paramiko.Ed25519Key, paramiko.ECDSAKey):
            try:
                key_file.seek(0)
                pkey = key_cls.from_private_key(key_file)
                break
            except Exception:
                continue

    client.connect(
        hostname=host.strip(),
        port=int(port),
        username=username.strip(),
        password=password if password else None,
        pkey=pkey,
        timeout=timeout,
        look_for_keys=False,
        allow_agent=False,
    )
    return client


def execute_remote_cmd(client: paramiko.SSHClient, cmd: str, timeout: int = 60) -> tuple[int, str, str]:
    """Execute a remote shell command and return (exit_code, stdout, stderr)."""
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    exit_code = stdout.channel.recv_exit_status()
    out_text = stdout.read().decode("utf-8", errors="replace").strip()
    err_text = stderr.read().decode("utf-8", errors="replace").strip()
    return exit_code, out_text, err_text


def test_ssh_connection(
    host: str,
    port: int = 22,
    username: str = "root",
    password: str | None = None,
    private_key: str | None = None,
) -> dict[str, Any]:
    """Simple ping and SSH authentication test."""
    t0 = time.time()
    try:
        client = create_ssh_client(host, port, username, password, private_key, timeout=8.0)
        elapsed_ms = round((time.time() - t0) * 1000, 1)
        code, out, _ = execute_remote_cmd(client, "uname -s && whoami")
        client.close()
        return {
            "ok": code == 0,
            "latency_ms": elapsed_ms,
            "message": f"Conexão SSH estabelecida com sucesso ({elapsed_ms}ms)!",
            "details": out,
        }
    except Exception as e:
        elapsed_ms = round((time.time() - t0) * 1000, 1)
        err_msg = str(e)
        if "Authentication failed" in err_msg:
            err_msg = "Falha de autenticação SSH: usuário ou senha/chave incorretos."
        elif "timed out" in err_msg.lower():
            err_msg = f"Tempo esgotado ao conectar ao IP {host}:{port}. Verifique firewall da VPS."
        return {
            "ok": False,
            "latency_ms": elapsed_ms,
            "error": err_msg,
        }


def run_destination_preflight(
    host: str,
    port: int = 22,
    username: str = "root",
    password: str | None = None,
    private_key: str | None = None,
    origin_arch: str = "x86_64",
    required_bytes: int = 0,
) -> dict[str, Any]:
    """Run full preflight audit on destination VPS."""
    t0 = time.time()
    client = None
    try:
        client = create_ssh_client(host, port, username, password, private_key, timeout=12.0)
        latency_ms = round((time.time() - t0) * 1000, 1)

        # 1. OS & Kernel & Architecture
        _, uname_m, _ = execute_remote_cmd(client, "uname -m")
        dest_arch = uname_m.strip()

        _, os_raw, _ = execute_remote_cmd(client, "cat /etc/os-release 2>/dev/null || true")
        os_info: dict[str, str] = {}
        for line in os_raw.splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                os_info[k.strip()] = v.strip().strip('"')

        dest_os_name = os_info.get("PRETTY_NAME", os_info.get("NAME", "Linux Desconhecido"))
        dest_os_id = os_info.get("ID", "").lower()
        dest_ver_id = os_info.get("VERSION_ID", "")

        # 2. Disk space on /
        # df -B1 / -> Filesystem 1B-blocks Used Available Use% Mounted on
        _, df_raw, _ = execute_remote_cmd(client, "df -B1 / | tail -n 1")
        disk_avail_bytes = 0
        disk_total_bytes = 0
        if df_raw:
            parts = df_raw.split()
            if len(parts) >= 4:
                try:
                    disk_total_bytes = int(parts[1])
                    disk_avail_bytes = int(parts[3])
                except ValueError:
                    pass

        disk_avail_gb = round(disk_avail_bytes / (1024**3), 2)
        disk_total_gb = round(disk_total_bytes / (1024**3), 2)
        req_gb = round(required_bytes / (1024**3), 2)

        # Safe margin: required + 20%
        margin_bytes = int(required_bytes * 1.2)
        disk_ok = disk_avail_bytes >= margin_bytes if required_bytes > 0 else True

        # 3. Check if clean (Docker status, Swarm status, Portainer)
        _, docker_check, _ = execute_remote_cmd(client, "command -v docker 2>/dev/null || echo ''")
        has_docker = bool(docker_check.strip())
        is_clean_vps = True
        running_containers = 0
        dest_swarm_active = False

        if has_docker:
            _, ps_count, _ = execute_remote_cmd(client, "docker ps -q 2>/dev/null | wc -l || echo 0")
            try:
                running_containers = int(ps_count.strip())
            except ValueError:
                pass

            _, swarm_st, _ = execute_remote_cmd(client, "docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || echo 'inactive'")
            dest_swarm_active = swarm_st.strip().lower() == "active"

            if running_containers > 0:
                is_clean_vps = False

        # 4. Check ports 80 and 443
        _, port_check, _ = execute_remote_cmd(client, "ss -tulpn | grep -E ':(80|443) ' || echo ''")
        ports_busy = bool(port_check.strip())

        # Checks evaluation
        arch_ok = (dest_arch == origin_arch)
        os_ok = dest_os_id in ("debian", "ubuntu", "centos", "almalinux", "rocky")

        warnings: list[str] = []
        errors: list[str] = []

        if not arch_ok:
            errors.append(f"Incompatibilidade de arquitetura: Origem é {origin_arch} e Destino é {dest_arch}.")

        if not disk_ok:
            errors.append(f"Espaço em disco insuficiente no Destino: Requer ~{req_gb} GB (+ margem de segurança) mas a VPS possui apenas {disk_avail_gb} GB livres.")

        if not is_clean_vps:
            warnings.append(f"A VPS de destino já possui {running_containers} containers rodando. Recomenda-se uma VPS limpa para evitar conflitos de portas e volumes.")

        if ports_busy:
            warnings.append("As portas 80 ou 443 já estão em uso no Destino por outro serviço (ex: Nginx, Apache). O Traefik precisará dessas portas.")

        client.close()

        passed_all = (len(errors) == 0)

        return {
            "ok": True,
            "passed": passed_all,
            "latency_ms": latency_ms,
            "destination": {
                "host": host,
                "port": port,
                "username": username,
                "os_name": dest_os_name,
                "os_id": dest_os_id,
                "version_id": dest_ver_id,
                "arch": dest_arch,
                "disk_total_gb": disk_total_gb,
                "disk_free_gb": disk_avail_gb,
                "has_docker": has_docker,
                "swarm_active": dest_swarm_active,
                "running_containers": running_containers,
                "ports_busy": ports_busy,
            },
            "checks": {
                "ssh_ok": True,
                "arch_ok": arch_ok,
                "os_ok": os_ok,
                "disk_ok": disk_ok,
                "clean_vps": is_clean_vps,
            },
            "warnings": warnings,
            "errors": errors,
        }
    except Exception as e:
        if client:
            try:
                client.close()
            except Exception:
                pass
        return {
            "ok": False,
            "passed": False,
            "error": f"Falha ao executar preflight no destino: {e}",
            "checks": {
                "ssh_ok": False,
                "arch_ok": False,
                "os_ok": False,
                "disk_ok": False,
                "clean_vps": False,
            },
            "warnings": [],
            "errors": [str(e)],
        }
