#!/usr/bin/env bash
# IMPA Migrate — Painel Web de Migração Docker Swarm & VPS (IMPA 365)
# Uso: bash install.sh   ou   bash <(curl -sSL https://migrator.impa365.com/painel)
set -euo pipefail

MIGRATOR_VERSION="1.2.0"
MIGRATOR_PORT="${MIGRATOR_PORT:-8899}"
INSTALL_DIR="/opt/impamigrate"
DADOS_DIR="/root/dados_vps"
LOG_FILE="/var/log/impa-migrator.log"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
GRAY='\033[0;90m'
BOLD='\033[1m'
RESET='\033[0m'

log() {
  echo "[$(date -Iseconds 2>/dev/null || date)] $*" >> "$LOG_FILE" 2>/dev/null || true
}

ok() {
  echo -e "    ${GREEN}✔${RESET} ${WHITE}$1${RESET}"
  log "OK: $1"
}

die() {
  echo ""
  echo -e "  ${RED}✖ ERRO:${RESET} ${WHITE}$1${RESET}"
  echo -e "  ${GRAY}Detalhes salvos em: $LOG_FILE${RESET}"
  echo ""
  log "FATAL: $1"
  exit 1
}

info() {
  echo -e "    ${CYAN}➜${RESET} ${GRAY}$1${RESET}"
  log "INFO: $1"
}

step() {
  echo ""
  echo -e "  ${CYAN}[$1]${RESET} ${BOLD}${WHITE}$2${RESET}"
  log "STEP: $1 - $2"
}

banner() {
  clear 2>/dev/null || true
  echo ""
  echo -e "  ${CYAN}┌──────────────────────────────────────────────────────────────┐${RESET}"
  echo -e "  ${CYAN}│${RESET}                                                              ${CYAN}│${RESET}"
  echo -e "  ${CYAN}│${RESET}   ${BOLD}${WHITE}🚀 IMPA MIGRATE — PAINEL WEB${RESET}  ${CYAN}v${MIGRATOR_VERSION}${RESET}                          ${CYAN}│${RESET}"
  echo -e "  ${CYAN}│${RESET}   ${GRAY}Migração Completa de Docker Swarm, Stacks & Volumes${RESET}         ${CYAN}│${RESET}"
  echo -e "  ${CYAN}│${RESET}   ${CYAN}https://migrator.impa365.com${RESET}  ·  ${WHITE}IMPA 365${RESET}                       ${CYAN}│${RESET}"
  echo -e "  ${CYAN}│${RESET}                                                              ${CYAN}│${RESET}"
  echo -e "  ${CYAN}└──────────────────────────────────────────────────────────────┘${RESET}"
}

require_root() {
  if [ "$(id -u 2>/dev/null || echo 1)" -ne 0 ]; then
    die "Você precisa executar este comando como root. Use: sudo bash <(curl -sSL https://migrator.impa365.com/painel)"
  fi
}

detect_public_ip() {
  local ip=""
  if [ -f "$DADOS_DIR/public_ip" ]; then
    ip="$(cat "$DADOS_DIR/public_ip" 2>/dev/null | tr -d ' \n\r')"
  fi
  if [ -z "$ip" ]; then
    for provider in "https://ifconfig.me/ip" "https://icanhazip.com" "https://api.ipify.org"; do
      ip="$(curl -fsS -m 4 "$provider" 2>/dev/null | tr -d ' \n\r' || true)"
      if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        break
      fi
      ip=""
    done
  fi
  echo "${ip:-127.0.0.1}"
}

ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    step "1/4" "Instalando Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || true
    ok "Docker instalado com sucesso"
  else
    ok "Docker já está instalado"
  fi
}

generate_token() {
  mkdir -p "$DADOS_DIR" "$INSTALL_DIR"
  local token=""
  if [ -f "$DADOS_DIR/migrator_auth.json" ]; then
    token="$(grep -o '"token": *"[^"]*"' "$DADOS_DIR/migrator_auth.json" | cut -d'"' -f4 || true)"
  fi
  if [ -z "$token" ]; then
    token="migrator_$(openssl rand -hex 24 2>/dev/null || tr -dc 'a-zA-Z0-9' < /dev/urandom | head -c 48)"
    cat <<EOF > "$DADOS_DIR/migrator_auth.json"
{
  "token": "$token",
  "created_at": $(date +%s),
  "role": "admin"
}
EOF
    chmod 600 "$DADOS_DIR/migrator_auth.json"
  fi
  echo "$token"
}

deploy_container() {
  step "2/4" "Preparando diretórios e arquivos..."
  mkdir -p "$INSTALL_DIR" "$DADOS_DIR"
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo "")"

  if [ -n "$script_dir" ] && [ -d "$script_dir/agent" ]; then
    cp -r "$script_dir/agent" "$INSTALL_DIR/"
    cp "$script_dir/docker-compose.agent.yml" "$INSTALL_DIR/" 2>/dev/null || true
  elif [ ! -d "$INSTALL_DIR/agent" ]; then
    info "Baixando arquivos do painel IMPA Migrate..."
    if curl -fsSL -m 15 "https://migrator.impa365.com/impamigrate.tar.gz" -o "/tmp/impamigrate.tar.gz" 2>/dev/null; then
      tar -xzf "/tmp/impamigrate.tar.gz" -C "$INSTALL_DIR" 2>/dev/null || true
      rm -f "/tmp/impamigrate.tar.gz"
    fi

    if [ ! -d "$INSTALL_DIR/agent" ]; then
      info "Clonando repositório oficial..."
      git clone --depth 1 https://github.com/impa365/impa-migrate.git /tmp/impa-repo-dl 2>/dev/null || true
      if [ -d "/tmp/impa-repo-dl/impamigrate/agent" ]; then
        cp -r /tmp/impa-repo-dl/impamigrate/agent "$INSTALL_DIR/"
        cp /tmp/impa-repo-dl/impamigrate/docker-compose.agent.yml "$INSTALL_DIR/" 2>/dev/null || true
      fi
      rm -rf /tmp/impa-repo-dl
    fi
  fi

  if [ ! -d "$INSTALL_DIR/agent" ]; then
    die "Não foi possível obter os arquivos do painel em $INSTALL_DIR/agent"
  fi

  step "3/4" "Subindo container do Painel de Migração..."
  docker rm -f impamigrate-agent 2>/dev/null || true

  local token="$1"
  local pub_ip="$2"

  docker run -d \
    --name impamigrate-agent \
    --restart unless-stopped \
    -p "${MIGRATOR_PORT}:8899" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v /root:/root \
    -v /var/lib/docker/volumes:/var/lib/docker/volumes \
    -v "$INSTALL_DIR:/opt/impamigrate" \
    -v /var/log:/var/log \
    -e MIGRATOR_TOKEN="$token" \
    -e MIGRATOR_PORT="8899" \
    -e MIGRATOR_PUBLIC_IP="$pub_ip" \
    -e IMPA_MIGRATOR_VERSION="$MIGRATOR_VERSION" \
    python:3.12-slim bash -c "
      apt-get update -qq && apt-get install -y -qq openssh-client sshpass pv curl >/dev/null 2>&1
      && pip install -q fastapi 'uvicorn[standard]' pydantic httpx docker PyYAML jinja2 paramiko
      && cd /opt/impamigrate/agent
      && python -m uvicorn app:app --host 0.0.0.0 --port 8899
    "

  ok "Container impamigrate-agent iniciado com sucesso"
}

wait_healthy() {
  step "4/4" "Verificando inicialização da API..."
  local attempts=0
  while [ $attempts -lt 25 ]; do
    if curl -fsS -m 2 "http://127.0.0.1:${MIGRATOR_PORT}/api/health" >/dev/null 2>&1; then
      ok "Painel online e respondendo na porta ${MIGRATOR_PORT}"
      return 0
    fi
    sleep 2
    attempts=$((attempts + 1))
  done
  die "O painel demorou para inicializar. Verifique: docker logs impamigrate-agent"
}

show_completion() {
  local token="$1"
  local pub_ip="$2"
  local panel_url="http://${pub_ip}:${MIGRATOR_PORT}/?token=${token}"

  echo ""
  echo -e "  ${GREEN}════════════════════════════════════════════════════════════════${RESET}"
  echo -e "  ${BOLD}${GREEN}✔ PAINEL IMPA MIGRATE INSTALADO COM SUCESSO!${RESET}"
  echo -e "  ${GREEN}════════════════════════════════════════════════════════════════${RESET}"
  echo ""
  echo -e "  ${BOLD}Acesse o painel pelo navegador:${RESET}"
  echo -e "  ${CYAN}${BOLD}${panel_url}${RESET}"
  echo ""
  echo -e "  ${GRAY}Token administrativo:${RESET} ${WHITE}${token}${RESET}"
  echo -e "  ${GRAY}Porta:${RESET} ${WHITE}${MIGRATOR_PORT}${RESET}"
  echo -e "  ${GRAY}Logs:${RESET} ${WHITE}docker logs -f impamigrate-agent${RESET}"
  echo ""
}

main() {
  require_root
  banner
  local pub_ip
  pub_ip="$(detect_public_ip)"
  ensure_docker
  local token
  token="$(generate_token)"
  deploy_container "$token" "$pub_ip"
  wait_healthy
  show_completion "$token" "$pub_ip"
}

main "$@"
