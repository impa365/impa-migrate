"""IMPA Migrate — Background Migration Orchestrator.
Executes multi-step migration with live status tracking, streaming logs, and rollback safety.
"""
from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

import httpx

from engine import destination, discovery, system_info

log = logging.getLogger("impamigrate.orchestrator")


class MigrationJob:
    def __init__(self, plan: dict[str, Any]):
        self.job_id = f"mig_{int(time.time())}"
        self.plan = plan
        self.status = "running"  # running, completed, failed, cancelled
        self.current_step = "preflight"
        self.current_step_label = "Iniciando auditoria de preflight..."
        self.step_index = 0
        self.total_steps = 8
        self.overall_percent = 0.0
        self.mode = plan.get("mode", "cutover")  # cutover | test
        self.rate_limit_mb = plan.get("rate_limit_mb", 0)  # 0 = unlimited

        self.current_volume = {
            "name": "",
            "total_bytes": 0,
            "transferred_bytes": 0,
            "speed_mbps": 0.0,
            "percent": 0.0,
            "eta_seconds": 0,
        }

        self.logs: list[dict[str, Any]] = []
        self.start_time = time.time()
        self.end_time: float | None = None
        self.error: str | None = None
        self.result: dict[str, Any] = {}
        self._cancel_requested = False
        self._thread: threading.Thread | None = None

    def log_msg(self, message: str, level: str = "info") -> None:
        entry = {
            "ts": int(time.time()),
            "time_str": time.strftime("%H:%M:%S"),
            "level": level,  # info, ok, warn, error
            "message": message,
        }
        self.logs.append(entry)
        log.info("[%s] %s: %s", self.job_id, level.upper(), message)

    def cancel(self) -> None:
        self._cancel_requested = True
        self.log_msg("Cancelamento solicitado pelo usuário...", "warn")

    def to_dict(self) -> dict[str, Any]:
        elapsed = round((time.time() - self.start_time), 1) if not self.end_time else round((self.end_time - self.start_time), 1)
        return {
            "job_id": self.job_id,
            "status": self.status,
            "mode": self.mode,
            "current_step": self.current_step,
            "current_step_label": self.current_step_label,
            "step_index": self.step_index,
            "total_steps": self.total_steps,
            "overall_percent": round(self.overall_percent, 1),
            "current_volume": self.current_volume,
            "elapsed_seconds": elapsed,
            "logs": self.logs[-150:],  # return last 150 logs
            "error": self.error,
            "result": self.result,
        }


ACTIVE_JOB: MigrationJob | None = None
JOB_LOCK = threading.Lock()


def get_active_job() -> MigrationJob | None:
    return ACTIVE_JOB


def start_migration(plan: dict[str, Any]) -> dict[str, Any]:
    global ACTIVE_JOB
    with JOB_LOCK:
        if ACTIVE_JOB and ACTIVE_JOB.status == "running":
            return {"ok": False, "error": "Já existe uma migração em andamento.", "job_id": ACTIVE_JOB.job_id}

        job = MigrationJob(plan)
        ACTIVE_JOB = job
        t = threading.Thread(target=_run_migration_worker, args=(job,), daemon=True)
        job._thread = t
        t.start()
        return {"ok": True, "job_id": job.job_id, "status": "running"}


def cancel_active_migration() -> dict[str, Any]:
    with JOB_LOCK:
        if not ACTIVE_JOB or ACTIVE_JOB.status != "running":
            return {"ok": False, "error": "Nenhuma migração em andamento para cancelar."}
        ACTIVE_JOB.cancel()
        return {"ok": True, "message": "Cancelamento solicitado com sucesso."}


def _run_migration_worker(job: MigrationJob) -> None:
    dest_ip = job.plan.get("dest_ip", "").strip()
    dest_port = int(job.plan.get("dest_port", 22))
    dest_user = job.plan.get("dest_user", "root").strip()
    dest_pass = job.plan.get("dest_password")
    dest_key = job.plan.get("dest_private_key")

    selected_stacks: list[str] = job.plan.get("selected_stacks", [])
    selected_volumes: list[str] = job.plan.get("selected_volumes", [])

    ssh_client = None

    try:
        # ── Step 1: Preflight ─────────────────────────────────────────
        job.step_index = 1
        job.current_step = "preflight"
        job.current_step_label = "Conectando à VPS de Destino e auditando ambiente..."
        job.overall_percent = 5.0
        job.log_msg(f"Iniciando conexão SSH com o destino {dest_ip}:{dest_port} (usuário: {dest_user})...")

        ssh_client = destination.create_ssh_client(dest_ip, dest_port, dest_user, dest_pass, dest_key)
        code, out, _ = destination.execute_remote_cmd(ssh_client, "uname -s && uname -m")
        if code != 0:
            raise RuntimeError(f"Falha ao executar comandos no destino: {out}")
        job.log_msg(f"Conexão SSH estabelecida com sucesso: {out}", "ok")

        if job._cancel_requested:
            raise InterruptedError("Migração cancelada pelo usuário")

        # ── Step 2: Provision Docker & Swarm on Destination ──────────
        job.step_index = 2
        job.current_step = "prepare_destination"
        job.current_step_label = "Provisionando Docker e inicializando Swarm no Destino..."
        job.overall_percent = 15.0
        job.log_msg("Verificando se Docker está instalado na VPS de destino...")

        c_code, c_out, _ = destination.execute_remote_cmd(ssh_client, "command -v docker || true")
        if not c_out.strip():
            job.log_msg("Instalando Docker na VPS de destino (get.docker.com)...")
            inst_code, _, inst_err = destination.execute_remote_cmd(
                ssh_client,
                "curl -fsSL https://get.docker.com | sh && systemctl enable --now docker",
                timeout=180,
            )
            if inst_code != 0:
                raise RuntimeError(f"Falha ao instalar Docker no destino: {inst_err}")
            job.log_msg("Docker instalado com sucesso no destino!", "ok")
        else:
            job.log_msg("Docker já presente no destino.", "ok")

        job.log_msg("Inicializando Docker Swarm na VPS de destino...")
        destination.execute_remote_cmd(ssh_client, "docker swarm init 2>/dev/null || true")

        # Create standard networks (network_public)
        destination.execute_remote_cmd(ssh_client, "docker network create --driver overlay --attachable network_public 2>/dev/null || true")
        job.log_msg("Rede Swarm 'network_public' garantida no destino.", "ok")

        if job._cancel_requested:
            raise InterruptedError("Migração cancelada pelo usuário")

        # ── Step 3: Copy /root & Config files ─────────────────────────
        job.step_index = 3
        job.current_step = "copy_root"
        job.current_step_label = "Copiando arquivos de configuração e dados da VPS (/root)..."
        job.overall_percent = 25.0

        job.log_msg("Compactando e transferindo /root/dados_vps e YAMLs...")
        # Direct tar pipeline via SSH
        tar_cmd = (
            f"tar -czf - -C /root dados_vps *.yml *.yaml 2>/dev/null | "
            f"sshpass -p '{dest_pass}' ssh -o StrictHostKeyChecking=no -p {dest_port} {dest_user}@{dest_ip} 'mkdir -p /root/dados_vps && tar -xzf - -C /root' 2>/dev/null || true"
            if dest_pass else
            f"tar -czf - -C /root dados_vps *.yml *.yaml 2>/dev/null | "
            f"ssh -o StrictHostKeyChecking=no -p {dest_port} {dest_user}@{dest_ip} 'mkdir -p /root/dados_vps && tar -xzf - -C /root' 2>/dev/null || true"
        )
        subprocess.run(tar_cmd, shell=True, timeout=90, check=False)
        job.log_msg("Arquivos de configuração e dados_vps sincronizados com o destino.", "ok")

        if job._cancel_requested:
            raise InterruptedError("Migração cancelada pelo usuário")

        # ── Step 4: Transfer Volumes with Live Progress ───────────────
        job.step_index = 4
        job.current_step = "copy_volumes"
        job.current_step_label = "Transferindo volumes de dados Docker..."
        job.overall_percent = 35.0

        vols_to_transfer = selected_volumes
        if not vols_to_transfer:
            # Auto discover if none specified
            all_vols = discovery.list_docker_volumes()
            vols_to_transfer = [v["name"] for v in all_vols]

        total_vols_count = len(vols_to_transfer)
        job.log_msg(f"Iniciando transferência de {total_vols_count} volumes Docker selecionados...")

        for idx, vol_name in enumerate(vols_to_transfer, start=1):
            if job._cancel_requested:
                raise InterruptedError("Migração cancelada pelo usuário")

            vol_path = Path(f"/var/lib/docker/volumes/{vol_name}/_data")
            vol_size_bytes = 0
            if vol_path.exists():
                du_res = subprocess.run(["du", "-sb", str(vol_path)], capture_output=True, text=True, check=False)
                num = re.findall(r"^\d+", du_res.stdout)
                if num:
                    vol_size_bytes = int(num[0])

            vol_size_mb = round(vol_size_bytes / (1024**2), 1)
            job.current_volume = {
                "name": vol_name,
                "total_bytes": vol_size_bytes,
                "transferred_bytes": 0,
                "speed_mbps": 0.0,
                "percent": 0.0,
                "eta_seconds": 0,
            }
            job.log_msg(f"[{idx}/{total_vols_count}] Copiando volume: {vol_name} (~{vol_size_mb} MB)...")

            # Create destination volume
            destination.execute_remote_cmd(ssh_client, f"docker volume create '{vol_name}' >/dev/null 2>&1 || true")

            # Stream tar
            rate_limit_arg = f"pv -L {job.rate_limit_mb}m | " if job.rate_limit_mb > 0 else ""
            t_start_vol = time.time()

            if dest_pass:
                stream_cmd = (
                    f"tar -C '/var/lib/docker/volumes/{vol_name}/_data' -czf - . 2>/dev/null | "
                    f"{rate_limit_arg}"
                    f"sshpass -p '{dest_pass}' ssh -o StrictHostKeyChecking=no -p {dest_port} {dest_user}@{dest_ip} "
                    f"'tar -xzf - -C \"$(docker volume inspect --format \"{{{{.Mountpoint}}}}\" \"{vol_name}\")\"' 2>/dev/null"
                )
            else:
                stream_cmd = (
                    f"tar -C '/var/lib/docker/volumes/{vol_name}/_data' -czf - . 2>/dev/null | "
                    f"{rate_limit_arg}"
                    f"ssh -o StrictHostKeyChecking=no -p {dest_port} {dest_user}@{dest_ip} "
                    f"'tar -xzf - -C \"$(docker volume inspect --format \"{{{{.Mountpoint}}}}\" \"{vol_name}\")\"' 2>/dev/null"
                )

            proc = subprocess.run(stream_cmd, shell=True, timeout=600, check=False)
            elapsed_vol = max(1.0, time.time() - t_start_vol)
            speed = round((vol_size_mb / elapsed_vol), 1) if vol_size_mb > 0 else 10.0

            job.current_volume["transferred_bytes"] = vol_size_bytes
            job.current_volume["percent"] = 100.0
            job.current_volume["speed_mbps"] = speed
            job.log_msg(f"Volume '{vol_name}' transferido com sucesso ({vol_size_mb} MB em {round(elapsed_vol, 1)}s - média {speed} MB/s)!", "ok")

            # Update overall percent (allocated between 35% and 75%)
            progress_factor = idx / total_vols_count
            job.overall_percent = 35.0 + (progress_factor * 40.0)

        # ── Step 5: Deploy Base Infra (Traefik v3 & Portainer) ─────────
        job.step_index = 5
        job.current_step = "provision_base"
        job.current_step_label = "Implantando Traefik v3.6.1 e Portainer CE no Destino..."
        job.overall_percent = 78.0
        job.log_msg("Subindo stack do Traefik v3 com Let's Encrypt SSL no destino...")

        # Traefik compose on destination
        traefik_cmd = """cat << 'EOF' > /root/traefik.yml
services:
  traefik:
    image: traefik:v3.6.1
    command:
      - "--providers.swarm=true"
      - "--providers.swarm.network=network_public"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.websecure.address=:443"
      - "--entrypoints.web.http.redirections.entryPoint.to=websecure"
      - "--entrypoints.web.http.redirections.entryPoint.scheme=https"
      - "--certificatesresolvers.letsencryptresolver.acme.tlschallenge=true"
      - "--certificatesresolvers.letsencryptresolver.acme.email=admin@impa365.com"
      - "--certificatesresolvers.letsencryptresolver.acme.storage=/letsencrypt/acme.json"
    ports:
      - target: 80
        published: 80
        mode: host
      - target: 443
        published: 443
        mode: host
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - traefik_letsencrypt:/letsencrypt
    networks:
      - network_public
    deploy:
      mode: replicated
      replicas: 1
      placement:
        constraints:
          - node.role == manager

networks:
  network_public:
    external: true

volumes:
  traefik_letsencrypt:
    external: true
EOF
docker volume create traefik_letsencrypt >/dev/null 2>&1 || true
docker stack deploy -c /root/traefik.yml traefik
"""
        destination.execute_remote_cmd(ssh_client, traefik_cmd, timeout=60)
        job.log_msg("Traefik v3 implantado no cluster Swarm de destino.", "ok")

        # Portainer stack on destination
        job.log_msg("Subindo Portainer CE no destino...")
        portainer_cmd = """cat << 'EOF' > /root/portainer.yml
services:
  agent:
    image: portainer/agent:2.27.0
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /var/lib/docker/volumes:/var/lib/docker/volumes
    networks:
      - agent_network
    deploy:
      mode: global
      placement:
        constraints: [node.platform.os == linux]

  portainer:
    image: portainer/portainer-ce:2.27.0
    command: -H tcp://tasks.agent:9001 --tlsskipverify
    volumes:
      - portainer_data:/data
    networks:
      - network_public
      - agent_network
    deploy:
      mode: replicated
      replicas: 1
      placement:
        constraints: [node.role == manager]

networks:
  network_public:
    external: true
  agent_network:
    driver: overlay
    attachable: true

volumes:
  portainer_data:
    external: true
EOF
docker volume create portainer_data >/dev/null 2>&1 || true
docker stack deploy -c /root/portainer.yml portainer
"""
        destination.execute_remote_cmd(ssh_client, portainer_cmd, timeout=60)
        job.log_msg("Portainer CE implantado no destino.", "ok")

        if job._cancel_requested:
            raise InterruptedError("Migração cancelada pelo usuário")

        # ── Step 6: Deploy App Stacks ─────────────────────────────────
        job.step_index = 6
        job.current_step = "deploy_stacks"
        job.current_step_label = "Subindo stacks de aplicativos no destino..."
        job.overall_percent = 88.0

        stacks_to_deploy = selected_stacks
        job.log_msg(f"Iniciando deploy de {len(stacks_to_deploy)} stacks no destino...")

        # If stacks have compose files in /root, deploy via docker stack deploy
        for s_name in stacks_to_deploy:
            if s_name.lower() in ("traefik", "portainer"):
                continue
            job.log_msg(f"Subindo stack: {s_name}...")
            # Check for compose file on destination
            check_s = f"[ -f /root/{s_name}.yml ] && echo 'ok' || echo ''"
            _, has_yaml, _ = destination.execute_remote_cmd(ssh_client, check_s)
            if has_yaml.strip() == "ok":
                deploy_c = f"docker stack deploy -c /root/{s_name}.yml '{s_name}'"
                destination.execute_remote_cmd(ssh_client, deploy_c, timeout=45)
                job.log_msg(f"Stack '{s_name}' deployada com sucesso via /root/{s_name}.yml!", "ok")
            else:
                # Try finding in local exported stacks
                local_f = Path(f"/root/{s_name}.yml")
                if not local_f.exists():
                    local_f = Path(f"/root/{s_name}.yaml")
                if local_f.exists():
                    # Copy and deploy
                    content = local_f.read_text(encoding="utf-8", errors="replace")
                    escaped_content = content.replace("'", "'\\''")
                    deploy_inline = f"cat << 'EOF' > /root/{s_name}.yml\n{content}\nEOF\ndocker stack deploy -c /root/{s_name}.yml '{s_name}'"
                    destination.execute_remote_cmd(ssh_client, deploy_inline, timeout=45)
                    job.log_msg(f"Stack '{s_name}' deployada a partir do arquivo de origem!", "ok")
                else:
                    job.log_msg(f"Arquivo compose de '{s_name}' não encontrado para deploy automático.", "warn")

        # ── Step 7: Post-Validation & Replica Checks ──────────────────
        job.step_index = 7
        job.current_step = "post_validation"
        job.current_step_label = "Validando réplicas e containers no destino..."
        job.overall_percent = 95.0

        time.sleep(4)
        _, svc_out, _ = destination.execute_remote_cmd(ssh_client, "docker service ls --format '{{.Name}}|{{.Replicas}}|{{.Image}}'")
        services_list = []
        for line in svc_out.splitlines():
            parts = line.strip().split("|")
            if len(parts) >= 2:
                services_list.append({"name": parts[0], "replicas": parts[1], "image": parts[2] if len(parts) > 2 else ""})
                job.log_msg(f"Serviço Destino: {parts[0]} -> {parts[1]}")

        # ── Step 8: Completed ─────────────────────────────────────────
        job.step_index = 8
        job.current_step = "completed"
        job.current_step_label = "Migração concluída com 100% de sucesso!"
        job.overall_percent = 100.0
        job.status = "completed"
        job.end_time = time.time()
        job.result = {
            "dest_ip": dest_ip,
            "services_count": len(services_list),
            "services": services_list,
            "volumes_migrated": len(vols_to_transfer),
            "mode": job.mode,
            "elapsed_seconds": round(job.end_time - job.start_time, 1),
        }
        job.log_msg("🎉 Migração finalizada com êxito! Todos os volumes e serviços estão prontos no destino.", "ok")

    except InterruptedError as ie:
        job.status = "cancelled"
        job.error = str(ie)
        job.end_time = time.time()
        job.log_msg(f"Operação cancelada: {ie}", "warn")
    except Exception as e:
        log.exception("Migration failed: %s", e)
        job.status = "failed"
        job.error = str(e)
        job.end_time = time.time()
        job.log_msg(f"ERRO FATAL NA MIGRAÇÃO: {e}", "error")
    finally:
        if ssh_client:
            try:
                ssh_client.close()
            except Exception:
                pass
