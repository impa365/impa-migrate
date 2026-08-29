#!/bin/bash
# IMPA Migrator — migração SetupOrion (Swarm + Traefik + Portainer + stacks + volumes)
# Rode na VPS de ORIGEM: sudo ./impa-migrator.sh
# Versão: 1.0.0-mvp

set -o pipefail

# =============================================================================
# Cores / UI
# =============================================================================
AMARELO="\e[33m"
VERDE="\e[32m"
BRANCO="\e[97m"
VERMELHO="\e[91m"
CIANO="\e[96m"
RESET="\e[0m"

LOG_FILE="/var/log/impa-migrator.log"
WORKDIR="/tmp/impa-migrator"
STATE_DIR="$WORKDIR/state"
INVENTORY="$STATE_DIR/inventory.txt"
STACKS_FILE="$STATE_DIR/stacks.txt"
VOLUMES_FILE="$STATE_DIR/volumes.txt"
NETWORKS_FILE="$STATE_DIR/networks.txt"
YAML_LIST="$STATE_DIR/yamls.txt"

DEST_IP=""
DEST_USER="root"
DEST_AUTH_MODE=""   # key | password
DEST_SSH_KEY=""
DEST_PASSWORD=""
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o ServerAliveInterval=30)
SSH_BASE=()
SCP_BASE=()

ORIGIN_OS=""
ORIGIN_VERSION=""
ORIGIN_ARCH=""
ORIGIN_SWARM=""
TOTAL_BYTES=0
TOTAL_HUMAN="0B"
ROOT_BYTES=0
ROOT_HUMAN="0B"
ESTIMATED_MIN=0
PORTAINER_URL=""
PORTAINER_USER=""
PORTAINER_PASS=""
FAILED_STEPS=0

# =============================================================================
# Helpers
# =============================================================================
log() {
  local msg="$1"
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $msg" >> "$LOG_FILE" 2>/dev/null || true
}

ok()   { echo -e "${VERDE}✓${RESET} ${BRANCO}$1${RESET}"; log "OK: $1"; }
off()  { echo -e "${VERMELHO}✗${RESET} ${BRANCO}$1${RESET}"; log "OFF: $1"; FAILED_STEPS=$((FAILED_STEPS + 1)); }
info() { echo -e "${CIANO}•${RESET} ${BRANCO}$1${RESET}"; log "INFO: $1"; }
warn() { echo -e "${AMARELO}!${RESET} ${BRANCO}$1${RESET}"; log "WARN: $1"; }
step() { echo -e "\n${AMARELO}▶${RESET} ${BRANCO}$1${RESET}\n"; log "STEP: $1"; }

die() {
  off "$1"
  echo ""
  echo -e "${VERMELHO}Migração abortada. A VPS de origem NÃO foi alterada (ou só foi pausada).${RESET}"
  echo -e "${BRANCO}Log: ${AMARELO}$LOG_FILE${RESET}"
  exit 1
}

confirm_yn() {
  local prompt="$1"
  local answer=""
  while true; do
    read -r -p "$(echo -e "${AMARELO}$prompt (Y/N): ${RESET}")" answer
    case "$answer" in
      Y|y) return 0 ;;
      N|n) return 1 ;;
      *) echo -e "${VERMELHO}Digite apenas Y ou N.${RESET}" ;;
    esac
  done
}

human_bytes() {
  local bytes="$1"
  if command -v numfmt >/dev/null 2>&1; then
    numfmt --to=iec --suffix=B "$bytes" 2>/dev/null && return
  fi
  awk -v b="$bytes" 'BEGIN {
    split("B KB MB GB TB", u, " ");
    i=1; while (b>=1024 && i<5) { b/=1024; i++ }
    printf "%.1f%s\n", b, u[i]
  }'
}

banner() {
  clear 2>/dev/null || true
  echo -e "${AMARELO}===================================================================================================${RESET}"
  echo -e "${AMARELO}=${RESET}                                                                                                 ${AMARELO}=${RESET}"
  echo -e "${AMARELO}=${RESET}  ${BRANCO}██╗███╗   ███╗██████╗  █████╗     ███╗   ███╗██╗ ██████╗ ██████╗  █████╗ ████████╗ ██████╗ ██████╗${RESET} ${AMARELO}=${RESET}"
  echo -e "${AMARELO}=${RESET}  ${BRANCO}██║████╗ ████║██╔══██╗██╔══██╗    ████╗ ████║██║██╔════╝ ██╔══██╗██╔══██╗╚══██╔══╝██╔═══██╗██╔══██╗${RESET}${AMARELO}=${RESET}"
  echo -e "${AMARELO}=${RESET}  ${BRANCO}██║██╔████╔██║██████╔╝███████║    ██╔████╔██║██║██║  ███╗██████╔╝███████║   ██║   ██║   ██║██████╔╝${RESET}${AMARELO}=${RESET}"
  echo -e "${AMARELO}=${RESET}  ${BRANCO}██║██║╚██╔╝██║██╔═══╝ ██╔══██║    ██║╚██╔╝██║██║██║   ██║██╔══██╗██╔══██║   ██║   ██║   ██║██╔══██╗${RESET}${AMARELO}=${RESET}"
  echo -e "${AMARELO}=${RESET}  ${BRANCO}██║██║ ╚═╝ ██║██║     ██║  ██║    ██║ ╚═╝ ██║██║╚██████╔╝██║  ██║██║  ██║   ██║   ╚██████╔╝██║  ██║${RESET}${AMARELO}=${RESET}"
  echo -e "${AMARELO}=${RESET}  ${BRANCO}╚═╝╚═╝     ╚═╝╚═╝     ╚═╝  ╚═╝    ╚═╝     ╚═╝╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝${RESET}${AMARELO}=${RESET}"
  echo -e "${AMARELO}=${RESET}                                                                                                 ${AMARELO}=${RESET}"
  echo -e "${AMARELO}=${RESET}  ${CIANO}Migração SetupOrion  ·  Swarm + Traefik + Portainer + Stacks + Volumes${RESET}                        ${AMARELO}=${RESET}"
  echo -e "${AMARELO}=${RESET}  ${BRANCO}v1.0.0-mvp  ·  IMPA 365${RESET}                                                                      ${AMARELO}=${RESET}"
  echo -e "${AMARELO}=${RESET}                                                                                                 ${AMARELO}=${RESET}"
  echo -e "${AMARELO}===================================================================================================${RESET}"
  echo ""
}

# =============================================================================
# SSH helpers
# =============================================================================
build_ssh() {
  SSH_BASE=(ssh "${SSH_OPTS[@]}")
  SCP_BASE=(scp "${SSH_OPTS[@]}")
  if [ "$DEST_AUTH_MODE" = "key" ]; then
    SSH_BASE+=(-i "$DEST_SSH_KEY")
    SCP_BASE+=(-i "$DEST_SSH_KEY")
  elif [ "$DEST_AUTH_MODE" = "password" ]; then
    if ! command -v sshpass >/dev/null 2>&1; then
      die "sshpass não encontrado. Instale: apt-get install -y sshpass  (ou use autenticação por chave SSH)"
    fi
    export SSHPASS="$DEST_PASSWORD"
    SSH_BASE=(sshpass -e ssh "${SSH_OPTS[@]}" -o PreferredAuthentications=password -o PubkeyAuthentication=no)
    SCP_BASE=(sshpass -e scp "${SSH_OPTS[@]}" -o PreferredAuthentications=password -o PubkeyAuthentication=no)
  fi
}

remote() {
  "${SSH_BASE[@]}" "${DEST_USER}@${DEST_IP}" "$@"
}

remote_bash() {
  "${SSH_BASE[@]}" "${DEST_USER}@${DEST_IP}" "bash -s" <<EOF
$*
EOF
}

# =============================================================================
# Validações locais
# =============================================================================
require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "Este script precisa rodar como root. Use: sudo ./impa-migrator.sh"
  fi
}

validate_origin_os() {
  if [ ! -f /etc/os-release ]; then
    die "Sistema operacional não suportado (/etc/os-release ausente)."
  fi
  # shellcheck disable=SC1091
  . /etc/os-release
  ORIGIN_OS="$ID"
  ORIGIN_VERSION="$VERSION_ID"
  ORIGIN_ARCH="$(uname -m)"

  case "$ORIGIN_OS" in
    debian)
      case "$ORIGIN_VERSION" in
        11|12|13) ;;
        *) die "Debian $ORIGIN_VERSION não homologado. Use Debian 11, 12 ou 13." ;;
      esac
      ;;
    ubuntu)
      case "$ORIGIN_VERSION" in
        22.04|23.04|23.10|24.04|24.10|25.04) ;;
        *) die "Ubuntu $ORIGIN_VERSION não homologado. Use Ubuntu 22.04+." ;;
      esac
      ;;
    *)
      die "Este migrador só roda em Debian ou Ubuntu. Detectado: $ORIGIN_OS $ORIGIN_VERSION"
      ;;
  esac

  if [ "$ORIGIN_ARCH" != "x86_64" ] && [ "$ORIGIN_ARCH" != "amd64" ]; then
    warn "Arquitetura $ORIGIN_ARCH — destino precisa ser idêntica."
  fi

  ok "SO origem: $PRETTY_NAME ($ORIGIN_ARCH)"
}

require_docker_swarm() {
  if ! command -v docker >/dev/null 2>&1; then
    die "Docker não encontrado na origem. Ambiente SetupOrion esperado."
  fi
  ok "Docker instalado"

  ORIGIN_SWARM="$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || echo inactive)"
  if [ "$ORIGIN_SWARM" != "active" ]; then
    die "Docker Swarm não está ativo. Este migrador é SetupOrion-first (Swarm obrigatório)."
  fi
  ok "Docker Swarm ativo"

  if ! docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qi 'portainer'; then
    warn "Container/serviço Portainer não detectado pelo nome — continuando se houver stacks."
  else
    ok "Portainer detectado"
  fi
}

# =============================================================================
# Discovery
# =============================================================================
discovery() {
  step "Analisando VPS de origem..."
  mkdir -p "$STATE_DIR"
  : > "$STACKS_FILE"
  : > "$VOLUMES_FILE"
  : > "$NETWORKS_FILE"
  : > "$YAML_LIST"
  : > "$INVENTORY"

  docker stack ls --format '{{.Name}}' 2>/dev/null | sort -u > "$STACKS_FILE" || true
  local stack_count
  stack_count=$(wc -l < "$STACKS_FILE" | tr -d ' ')
  if [ "$stack_count" -eq 0 ]; then
    die "Nenhuma stack Swarm encontrada. Ambiente não parece SetupOrion."
  fi
  ok "$stack_count stack(s) encontrada(s)"

  # Redes overlay (exceto ingress)
  docker network ls --filter driver=overlay --format '{{.Name}}' 2>/dev/null \
    | grep -v '^ingress$' | sort -u > "$NETWORKS_FILE" || true
  local net_count
  net_count=$(wc -l < "$NETWORKS_FILE" | tr -d ' ')
  ok "$net_count rede(s) overlay"

  # Volumes named (exclui os anônimos de 64 hex se aparecerem)
  docker volume ls --format '{{.Name}}' 2>/dev/null | sort -u > "$VOLUMES_FILE" || true
  local vol_count
  vol_count=$(wc -l < "$VOLUMES_FILE" | tr -d ' ')
  ok "$vol_count volume(s)"

  # YAMLs em /root
  find /root -maxdepth 1 \( -type f -name '*.yaml' -o -type f -name '*.yml' \) 2>/dev/null \
    | sort > "$YAML_LIST" || true
  local yaml_count
  yaml_count=$(wc -l < "$YAML_LIST" | tr -d ' ')
  if [ "$yaml_count" -eq 0 ]; then
    warn "Nenhum YAML em /root — restore de stacks pode falhar. Continuando."
  else
    ok "$yaml_count YAML(s) em /root"
  fi

  if [ -d /root/dados_vps ]; then
    ok "Pasta /root/dados_vps encontrada"
    if [ -f /root/dados_vps/dados_portainer ]; then
      PORTAINER_URL=$(grep -oP '(?<=Dominio do portainer: ).*' /root/dados_vps/dados_portainer 2>/dev/null | head -1 || true)
      PORTAINER_USER=$(grep -oP '(?<=Usuario: ).*' /root/dados_vps/dados_portainer 2>/dev/null | head -1 || true)
      PORTAINER_PASS=$(grep -oP '(?<=Senha: ).*' /root/dados_vps/dados_portainer 2>/dev/null | head -1 || true)
      [ -n "$PORTAINER_URL" ] && ok "Credenciais Portainer lidas ($PORTAINER_URL)"
    fi
  else
    warn "/root/dados_vps não encontrada"
  fi

  # Tamanho útil de /root (SetupOrion: YAMLs, dados_vps, scripts, etc.)
  ROOT_BYTES=$(du -sb /root --exclude=/root/.cache --exclude=/root/.local --exclude=/root/.npm 2>/dev/null | awk '{print $1}')
  ROOT_BYTES=${ROOT_BYTES:-0}
  ROOT_HUMAN=$(human_bytes "$ROOT_BYTES")
  ok "Conteúdo de /root a migrar: $ROOT_HUMAN"

  # Tamanho dos volumes
  TOTAL_BYTES=0
  : > "$STATE_DIR/volume_sizes.txt"
  echo ""
  info "Calculando tamanho dos volumes..."
  while IFS= read -r vol || [ -n "$vol" ]; do
    [ -z "$vol" ] && continue
    local path="/var/lib/docker/volumes/${vol}/_data"
    local size=0
    if [ -d "$path" ]; then
      size=$(du -sb "$path" 2>/dev/null | awk '{print $1}')
      size=${size:-0}
    fi
    TOTAL_BYTES=$((TOTAL_BYTES + size))
    printf "%s\t%s\n" "$vol" "$size" >> "$STATE_DIR/volume_sizes.txt"
    echo -e "  ${BRANCO}$vol${RESET}  $(human_bytes "$size")"
  done < "$VOLUMES_FILE"

  TOTAL_HUMAN=$(human_bytes "$TOTAL_BYTES")
  # Estimativa grosseira: ~50 MB/s efetivo via SSH compressão média
  ESTIMATED_MIN=$(( TOTAL_BYTES / 50 / 1024 / 1024 ))
  [ "$ESTIMATED_MIN" -lt 5 ] && ESTIMATED_MIN=5
  ESTIMATED_MIN=$((ESTIMATED_MIN + 10)) # provision + restore

  {
    echo "OS=$ORIGIN_OS $ORIGIN_VERSION"
    echo "ARCH=$ORIGIN_ARCH"
    echo "STACKS=$stack_count"
    echo "NETWORKS=$net_count"
    echo "VOLUMES=$vol_count"
    echo "YAMLS=$yaml_count"
    echo "TOTAL_BYTES=$TOTAL_BYTES"
    echo "TOTAL_HUMAN=$TOTAL_HUMAN"
  } > "$INVENTORY"

  echo ""
  ok "Dados totais: $TOTAL_HUMAN"
  ok "Tempo estimado: ~${ESTIMATED_MIN} min (depende da rede)"
}

show_inventory() {
  echo -e "${AMARELO}──────────────────────────────────────────────────────────────────────────────${RESET}"
  echo -e "${BRANCO}  INVENTÁRIO DA ORIGEM${RESET}"
  echo -e "${AMARELO}──────────────────────────────────────────────────────────────────────────────${RESET}"
  echo -e "  SO:           ${CIANO}$ORIGIN_OS $ORIGIN_VERSION${RESET} ($ORIGIN_ARCH)"
  echo -e "  Swarm:        ${CIANO}$ORIGIN_SWARM${RESET}"
  echo -e "  Stacks:       ${CIANO}$(wc -l < "$STACKS_FILE" | tr -d ' ')${RESET}"
  while IFS= read -r s || [ -n "$s" ]; do
    [ -z "$s" ] && continue
    echo -e "                - $s"
  done < "$STACKS_FILE"
  echo -e "  Redes:        ${CIANO}$(wc -l < "$NETWORKS_FILE" | tr -d ' ')${RESET}"
  while IFS= read -r n || [ -n "$n" ]; do
    [ -z "$n" ] && continue
    echo -e "                - $n"
  done < "$NETWORKS_FILE"
  echo -e "  Volumes:      ${CIANO}$(wc -l < "$VOLUMES_FILE" | tr -d ' ')${RESET}"
  echo -e "  Dados:        ${CIANO}$TOTAL_HUMAN${RESET}"
  echo -e "  YAMLs /root:  ${CIANO}$(wc -l < "$YAML_LIST" | tr -d ' ')${RESET}"
  echo -e "  Pasta /root:  ${CIANO}${ROOT_HUMAN:-?}${RESET} (YAMLs, dados_vps e demais arquivos Orion)"
  echo -e "${AMARELO}──────────────────────────────────────────────────────────────────────────────${RESET}"
  echo ""
}

# =============================================================================
# Destino — perguntas + preflight
# =============================================================================
ask_destination() {
  step "Configurando VPS de destino"
  echo -e "${BRANCO}A VPS de destino DEVE ser nova/limpa (Debian 11–13 ou Ubuntu 22.04+), sem Docker.${RESET}"
  echo ""

  while true; do
    read -r -p "$(echo -e "${AMARELO}IP da VPS nova: ${RESET}")" DEST_IP
    if [[ "$DEST_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      break
    fi
    echo -e "${VERMELHO}IP inválido.${RESET}"
  done

  read -r -p "$(echo -e "${AMARELO}Usuário SSH [${DEST_USER}]: ${RESET}")" tmp_user
  [ -n "$tmp_user" ] && DEST_USER="$tmp_user"

  echo ""
  echo -e "${BRANCO}Autenticação SSH:${RESET}"
  echo -e "  ${AMARELO}[1]${RESET} Chave SSH"
  echo -e "  ${AMARELO}[2]${RESET} Senha"
  while true; do
    read -r -p "$(echo -e "${AMARELO}Escolha [1/2]: ${RESET}")" auth
    case "$auth" in
      1)
        DEST_AUTH_MODE="key"
        default_key="${HOME}/.ssh/id_rsa"
        [ -f "${HOME}/.ssh/id_ed25519" ] && default_key="${HOME}/.ssh/id_ed25519"
        read -r -p "$(echo -e "${AMARELO}Caminho da chave [${default_key}]: ${RESET}")" DEST_SSH_KEY
        [ -z "$DEST_SSH_KEY" ] && DEST_SSH_KEY="$default_key"
        [ -f "$DEST_SSH_KEY" ] || die "Chave não encontrada: $DEST_SSH_KEY"
        break
        ;;
      2)
        DEST_AUTH_MODE="password"
        read -r -s -p "$(echo -e "${AMARELO}Senha SSH de ${DEST_USER}@${DEST_IP}: ${RESET}")" DEST_PASSWORD
        echo ""
        [ -n "$DEST_PASSWORD" ] || die "Senha vazia."
        break
        ;;
      *) echo -e "${VERMELHO}Digite 1 ou 2.${RESET}" ;;
    esac
  done

  build_ssh
}

preflight_destination() {
  step "Preflight na VPS de destino ($DEST_IP)"

  if ! remote "echo ok" >/dev/null 2>&1; then
    die "Falha ao conectar via SSH em ${DEST_USER}@${DEST_IP}"
  fi
  ok "SSH conectado"

  local remote_check
  remote_check=$(remote 'bash -s' <<'REMOTE'
set -e
. /etc/os-release 2>/dev/null || { echo "OS_FAIL"; exit 0; }
echo "OS=$ID"
echo "VER=$VERSION_ID"
echo "ARCH=$(uname -m)"
echo "FREE=$(df -B1 / | awk 'NR==2{print $4}')"
if command -v docker >/dev/null 2>&1; then
  echo "DOCKER=yes"
else
  echo "DOCKER=no"
fi
# containers / processos docker
if [ -S /var/run/docker.sock ] 2>/dev/null; then
  echo "SOCK=yes"
fi
REMOTE
) || die "Falha ao coletar informações do destino."

  local dest_os dest_ver dest_arch dest_free dest_docker
  dest_os=$(echo "$remote_check" | grep '^OS=' | cut -d= -f2)
  dest_ver=$(echo "$remote_check" | grep '^VER=' | cut -d= -f2)
  dest_arch=$(echo "$remote_check" | grep '^ARCH=' | cut -d= -f2)
  dest_free=$(echo "$remote_check" | grep '^FREE=' | cut -d= -f2)
  dest_docker=$(echo "$remote_check" | grep '^DOCKER=' | cut -d= -f2)

  case "$dest_os" in
    debian)
      case "$dest_ver" in
        11|12|13) ok "Destino: Debian $dest_ver" ;;
        *) die "Debian $dest_ver no destino não homologado." ;;
      esac
      ;;
    ubuntu)
      case "$dest_ver" in
        22.04|23.04|23.10|24.04|24.10|25.04) ok "Destino: Ubuntu $dest_ver" ;;
        *) die "Ubuntu $dest_ver no destino não homologado." ;;
      esac
      ;;
    *)
      die "Destino deve ser Debian/Ubuntu. Detectado: $dest_os $dest_ver"
      ;;
  esac

  if [ "$dest_arch" != "$ORIGIN_ARCH" ]; then
    die "Arquitetura incompatível. Origem=$ORIGIN_ARCH Destino=$dest_arch"
  fi
  ok "Arquitetura compatível ($dest_arch)"

  if [ "$dest_docker" = "yes" ]; then
    die "Docker já existe no destino. Use uma VPS limpa (Greenfield)."
  fi
  ok "VPS limpa (sem Docker)"

  # margem 15% + root + 5GB
  local needed=$(( TOTAL_BYTES + ROOT_BYTES + (TOTAL_BYTES + ROOT_BYTES) / 7 + 5 * 1024 * 1024 * 1024 ))
  if [ -n "$dest_free" ] && [ "$dest_free" -lt "$needed" ] 2>/dev/null; then
    die "Espaço insuficiente no destino. Livre=$(human_bytes "$dest_free") Necessário≈$(human_bytes "$needed")"
  fi
  ok "Espaço suficiente (livre $(human_bytes "${dest_free:-0}"))"
}

# =============================================================================
# Resumo + trava
# =============================================================================
show_summary_and_confirm() {
  step "Resumo da migração"
  echo -e "${AMARELO}──────────────────────────────────────────────────────────────────────────────${RESET}"
  echo -e "  ${BRANCO}ORIGEM${RESET}  →  esta VPS ($ORIGIN_OS $ORIGIN_VERSION / $ORIGIN_ARCH)"
  echo -e "  ${BRANCO}DESTINO${RESET} →  ${CIANO}${DEST_USER}@${DEST_IP}${RESET}"
  echo ""
  echo -e "  Stacks:   $(wc -l < "$STACKS_FILE" | tr -d ' ')"
  echo -e "  Volumes:  $(wc -l < "$VOLUMES_FILE" | tr -d ' ')  ($TOTAL_HUMAN)"
  echo -e "  Redes:    $(wc -l < "$NETWORKS_FILE" | tr -d ' ')"
  echo -e "  YAMLs:    $(wc -l < "$YAML_LIST" | tr -d ' ')"
  echo -e "  /root:    ${ROOT_HUMAN:-?} (pasta completa SetupOrion)"
  echo -e "  Tempo:    ~${ESTIMATED_MIN} min"
  echo ""
  echo -e "  ${AMARELO}O que acontece:${RESET}"
  echo -e "  1. Instala Docker + Swarm no destino"
  echo -e "  2. Recria redes overlay e volumes"
  echo -e "  3. Pausa stacks na ORIGEM (dados consistentes)"
  echo -e "  4. Transfere volumes + pasta /root (YAMLs, dados_vps, etc.)"
  echo -e "  5. Sobe Traefik → Portainer → demais stacks"
  echo -e "  6. Origem permanece intacta (só pausada)"
  echo ""
  echo -e "  ${VERMELHO}Após a migração, aponte o DNS A dos domínios para ${DEST_IP}${RESET}"
  echo -e "${AMARELO}──────────────────────────────────────────────────────────────────────────────${RESET}"
  echo ""

  local lock=""
  read -r -p "$(echo -e "${VERMELHO}Digite MIGRAR para iniciar: ${RESET}")" lock
  if [ "$lock" != "MIGRAR" ]; then
    die "Confirmação inválida. Nada foi alterado."
  fi
  ok "Confirmação recebida — iniciando"
}

# =============================================================================
# Provision destino
# =============================================================================
provision_destination() {
  step "Provisionando destino (Docker + Swarm)"

  remote 'bash -s' <<'REMOTE' || die "Falha ao instalar Docker no destino"
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg lsb-release tar >/dev/null
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable docker
systemctl start docker
docker --version
REMOTE
  ok "Docker instalado no destino"

  remote 'bash -s' <<REMOTE || die "Falha ao iniciar Swarm no destino"
set -e
STATE=\$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || echo inactive)
if [ "\$STATE" != "active" ]; then
  docker swarm init --advertise-addr ${DEST_IP}
fi
docker info --format '{{.Swarm.LocalNodeState}}'
REMOTE
  ok "Swarm ativo no destino"

  # Redes overlay
  step "Recriando redes overlay"
  while IFS= read -r net || [ -n "$net" ]; do
    [ -z "$net" ] && continue
    if remote "docker network inspect '$net' >/dev/null 2>&1"; then
      ok "Rede já existe: $net"
    else
      if remote "docker network create --driver overlay --attachable '$net'"; then
        ok "Rede criada: $net"
      else
        off "Falha ao criar rede: $net"
      fi
    fi
  done < "$NETWORKS_FILE"

  # Volumes vazios
  step "Criando volumes no destino"
  while IFS= read -r vol || [ -n "$vol" ]; do
    [ -z "$vol" ] && continue
    if remote "docker volume inspect '$vol' >/dev/null 2>&1"; then
      ok "Volume já existe: $vol"
    else
      if remote "docker volume create '$vol' >/dev/null"; then
        ok "Volume criado: $vol"
      else
        off "Falha ao criar volume: $vol"
      fi
    fi
  done < "$VOLUMES_FILE"
}

# =============================================================================
# Freeze origem
# =============================================================================
freeze_origin() {
  step "Pausando stacks na origem (consistência de dados)"
  warn "Os serviços ficarão offline até você religá-los ou concluir a migração."

  # Scale services to 0 where possible; fallback docker service update --replicas 0
  while IFS= read -r stack || [ -n "$stack" ]; do
    [ -z "$stack" ] && continue
    info "Pausando stack: $stack"
    # Lista serviços da stack e replica 0
    local services
    services=$(docker stack services "$stack" --format '{{.Name}}' 2>/dev/null || true)
    if [ -z "$services" ]; then
      warn "Nenhum serviço em $stack"
      continue
    fi
    while IFS= read -r svc || [ -n "$svc" ]; do
      [ -z "$svc" ] && continue
      if docker service scale "${svc}=0" >/dev/null 2>&1; then
        ok "  $svc → 0"
      else
        docker service update --replicas 0 "$svc" >/dev/null 2>&1 && ok "  $svc → 0" || off "  Falha ao pausar $svc"
      fi
    done <<< "$services"
  done < "$STACKS_FILE"

  info "Aguardando flush de I/O (10s)..."
  sleep 10
  ok "Origem pausada"
}

# =============================================================================
# Transfer
# =============================================================================
transfer_volume() {
  local vol="$1"
  local src="/var/lib/docker/volumes/${vol}/_data"
  local size_line size
  size_line=$(grep -P "^${vol}\t" "$STATE_DIR/volume_sizes.txt" 2>/dev/null || true)
  size=$(echo "$size_line" | awk -F'\t' '{print $2}')
  size=${size:-0}

  # Portainer guarda Swarm ID / stacks no volume — no destino o Swarm é novo.
  # Copiar portainer_data deixa UI órfã; stacks sobem pelos YAMLs + docker stack deploy.
  if [ "$vol" = "portainer_data" ]; then
    warn "Pulando conteúdo de portainer_data (MVP: recria admin; stacks vêm dos YAMLs)"
    return 0
  fi

  if [ ! -d "$src" ]; then
    warn "Volume sem _data local: $vol (pulando conteúdo)"
    return 0
  fi

  info "Transferindo $vol ($(human_bytes "$size"))..."

  local attempt=1
  local max=3
  while [ "$attempt" -le "$max" ]; do
    if command -v pv >/dev/null 2>&1 && [ "$size" -gt 0 ]; then
      if tar -C "$src" -cf - . 2>/dev/null | pv -s "$size" | remote "mkdir -p /var/lib/docker/volumes/${vol}/_data && tar -C /var/lib/docker/volumes/${vol}/_data -xf -"; then
        ok "Volume $vol transferido"
        return 0
      fi
    else
      if tar -C "$src" -cf - . 2>/dev/null | remote "mkdir -p /var/lib/docker/volumes/${vol}/_data && tar -C /var/lib/docker/volumes/${vol}/_data -xf -"; then
        ok "Volume $vol transferido ($(human_bytes "$size"))"
        return 0
      fi
    fi
    warn "Tentativa $attempt/$max falhou para $vol — retry em 5s"
    attempt=$((attempt + 1))
    sleep 5
  done
  off "Falha ao transferir volume: $vol"
  return 1
}

transfer_root() {
  step "Transferindo pasta /root (SetupOrion)"
  info "Copia YAMLs, dados_vps, scripts e demais arquivos de /root"
  info "Tamanho estimado: $ROOT_HUMAN"
  # Exclui só lixo/cache — mantém .ssh, dados_vps, *.yaml, etc.
  local excludes=(
    --exclude='./.cache'
    --exclude='./.local'
    --exclude='./.npm'
    --exclude='./.composer/cache'
    --exclude='./.wget-hsts'
    --exclude='./.viminfo'
    --exclude='./.lesshst'
  )

  remote "mkdir -p /root"

  local attempt=1
  local max=3
  while [ "$attempt" -le "$max" ]; do
    if command -v pv >/dev/null 2>&1 && [ "${ROOT_BYTES:-0}" -gt 0 ]; then
      if tar -C /root "${excludes[@]}" -cf - . 2>/dev/null \
        | pv -s "$ROOT_BYTES" \
        | remote "tar -C /root -xf -"; then
        ok "Pasta /root transferida ($ROOT_HUMAN)"
        # Sanity checks típicos do Orion
        remote "test -d /root/dados_vps" && ok "dados_vps presente no destino" || warn "dados_vps não encontrado no destino"
        local yaml_dest
        yaml_dest=$(remote "ls /root/*.yaml /root/*.yml 2>/dev/null | wc -l" | tr -d ' \r' || echo 0)
        ok "YAMLs no destino: $yaml_dest"
        return 0
      fi
    else
      if tar -C /root "${excludes[@]}" -cf - . 2>/dev/null \
        | remote "tar -C /root -xf -"; then
        ok "Pasta /root transferida ($ROOT_HUMAN)"
        remote "test -d /root/dados_vps" && ok "dados_vps presente no destino" || warn "dados_vps não encontrado no destino"
        local yaml_dest
        yaml_dest=$(remote "ls /root/*.yaml /root/*.yml 2>/dev/null | wc -l" | tr -d ' \r' || echo 0)
        ok "YAMLs no destino: $yaml_dest"
        return 0
      fi
    fi
    warn "Tentativa $attempt/$max falhou ao copiar /root — retry em 5s"
    attempt=$((attempt + 1))
    sleep 5
  done
  off "Falha ao transferir pasta /root"
  return 1
}

transfer_all() {
  step "Transferindo volumes"
  local i=0
  local total
  total=$(wc -l < "$VOLUMES_FILE" | tr -d ' ')
  while IFS= read -r vol || [ -n "$vol" ]; do
    [ -z "$vol" ] && continue
    i=$((i + 1))
    echo -e "${AMARELO}[$i/$total]${RESET}"
    transfer_volume "$vol" || true
  done < "$VOLUMES_FILE"

  transfer_root || true
}

# =============================================================================
# Restore stacks
# =============================================================================
deploy_stack_remote() {
  local name="$1"
  local file="$2"
  remote "test -f /root/$file" || { off "YAML ausente no destino: $file"; return 1; }
  if remote "docker stack deploy --prune --resolve-image always -c /root/$file $name"; then
    ok "Stack deploy: $name"
    return 0
  fi
  off "Falha deploy: $name"
  return 1
}

restore_stacks() {
  step "Restaurando stacks no destino"

  # Ordem: traefik → portainer → resto
  local deployed_list="$STATE_DIR/deployed.txt"
  : > "$deployed_list"

  if [ -f /root/traefik.yaml ] || remote "test -f /root/traefik.yaml"; then
    deploy_stack_remote "traefik" "traefik.yaml" && echo traefik >> "$deployed_list"
    info "Aguardando Traefik estabilizar (20s)..."
    sleep 20
  else
    warn "traefik.yaml não encontrado — pulando Traefik"
  fi

  if remote "test -f /root/portainer.yaml"; then
    # Não restauramos portainer_data do volume antigo como fonte de stacks
    # (Swarm ID muda). Volume portainer_data pode ter sido copiado; se existir
    # e causar conflito de admin, removemos o conteúdo de auth e recriamos.
    deploy_stack_remote "portainer" "portainer.yaml" && echo portainer >> "$deployed_list"
    info "Aguardando Portainer (25s)..."
    sleep 25
    init_portainer_admin || true
  else
    warn "portainer.yaml não encontrado — pulando Portainer"
  fi

  # Demais YAMLs: nome da stack = basename sem extensão
  while IFS= read -r yaml || [ -n "$yaml" ]; do
    [ -z "$yaml" ] && continue
    local base name
    base=$(basename "$yaml")
    name="${base%.yaml}"
    name="${name%.yml}"
    case "$name" in
      traefik|portainer) continue ;;
    esac
    # Só deploy se a stack existia na origem
    if grep -qx "$name" "$STACKS_FILE" 2>/dev/null; then
      deploy_stack_remote "$name" "$base" && echo "$name" >> "$deployed_list"
    else
      # YAML sem stack correspondente — tenta mesmo assim se nome limpo
      if remote "test -f /root/$base"; then
        info "YAML extra $base — tentando deploy como stack $name"
        deploy_stack_remote "$name" "$base" && echo "$name" >> "$deployed_list" || true
      fi
    fi
  done < "$YAML_LIST"

  # Stacks da origem sem YAML correspondente
  while IFS= read -r stack || [ -n "$stack" ]; do
    [ -z "$stack" ] && continue
    if grep -qx "$stack" "$deployed_list" 2>/dev/null; then
      continue
    fi
    if remote "test -f /root/${stack}.yaml"; then
      deploy_stack_remote "$stack" "${stack}.yaml" && echo "$stack" >> "$deployed_list"
    elif remote "test -f /root/${stack}.yml"; then
      deploy_stack_remote "$stack" "${stack}.yml" && echo "$stack" >> "$deployed_list"
    else
      warn "Stack '$stack' sem YAML em /root — não foi possível redeploy automático"
    fi
  done < "$STACKS_FILE"
}

init_portainer_admin() {
  step "Recriando admin do Portainer (Swarm ID novo)"
  if [ -z "$PORTAINER_URL" ] || [ -z "$PORTAINER_USER" ] || [ -z "$PORTAINER_PASS" ]; then
    warn "Sem credenciais em dados_portainer — crie o admin manualmente no Portainer novo."
    return 1
  fi

  # Remove https:// se houver
  local url="$PORTAINER_URL"
  url="${url#https://}"
  url="${url#http://}"

  info "Tentando admin/init em https://$url ..."
  local i
  for i in 1 2 3 4 5; do
    local response
    response=$(curl -k -s -X POST "https://$url/api/users/admin/init" \
      -H "Content-Type: application/json" \
      -d "{\"Username\": \"$PORTAINER_USER\", \"Password\": \"$PORTAINER_PASS\"}" 2>/dev/null || true)
    if echo "$response" | grep -q "\"Username\""; then
      ok "Admin Portainer criado ($PORTAINER_USER)"
      return 0
    fi
    # Já existe admin
    if echo "$response" | grep -qi 'already'; then
      warn "Admin já existe no Portainer — use as credenciais atuais do volume ou reset."
      return 0
    fi
    info "Tentativa $i/5 — aguardando DNS/Traefik (DNS ainda pode apontar para IP antigo)"
    sleep 10
  done
  warn "Não foi possível init via API (normal se DNS ainda aponta para a origem)."
  warn "Acesse Portainer no IP novo após apontar o DNS, ou via IP: se a stack publicar porta."
  return 1
}

# =============================================================================
# Validation
# =============================================================================
validate_migration() {
  step "Validando destino"
  echo ""
  echo -e "${BRANCO}Stacks no destino:${RESET}"
  remote "docker stack ls" || warn "Não listou stacks"

  echo ""
  echo -e "${BRANCO}Serviços (resumo):${RESET}"
  remote "docker service ls" || warn "Não listou serviços"

  echo ""
  local origin_stacks dest_stacks
  origin_stacks=$(wc -l < "$STACKS_FILE" | tr -d ' ')
  dest_stacks=$(remote "docker stack ls --format '{{.Name}}' | wc -l" 2>/dev/null | tr -d ' \r' || echo 0)
  if [ "$dest_stacks" -ge 1 ]; then
    ok "Destino tem $dest_stacks stack(s) (origem tinha $origin_stacks)"
  else
    off "Nenhuma stack no destino"
  fi
}

final_report() {
  step "Migração concluída"
  echo -e "${AMARELO}===================================================================================================${RESET}"
  echo -e "${VERDE}  IMPA Migrator — relatório final${RESET}"
  echo -e "${AMARELO}===================================================================================================${RESET}"
  echo ""
  echo -e "  Destino:     ${CIANO}${DEST_USER}@${DEST_IP}${RESET}"
  echo -e "  Dados:       ${CIANO}$TOTAL_HUMAN${RESET}"
  if [ -n "$PORTAINER_URL" ]; then
    echo -e "  Portainer:   ${CIANO}https://${PORTAINER_URL#https://}${RESET}"
    echo -e "  Usuário:     ${CIANO}$PORTAINER_USER${RESET}"
  fi
  echo ""
  echo -e "  ${AMARELO}PRÓXIMOS PASSOS OBRIGATÓRIOS:${RESET}"
  echo -e "  1. Apontar os registros DNS A dos seus domínios para ${VERDE}${DEST_IP}${RESET}"
  echo -e "  2. Aguardar propagação DNS e testar Traefik/Portainer/apps"
  echo -e "  3. Só então desligar/cancelar a VPS antiga"
  echo ""
  echo -e "  ${BRANCO}A origem está PAUSADA (replicas=0), mas intacta.${RESET}"
  echo -e "  ${BRANCO}Para religar a origem (rollback):${RESET}"
  echo -e "    ${CIANO}# em cada serviço: docker service scale NOME=1${RESET}"
  echo -e "    ${CIANO}# ou: docker stack deploy -c /root/STACK.yaml STACK${RESET}"
  echo ""
  echo -e "  Log completo: ${AMARELO}$LOG_FILE${RESET}"
  if [ "$FAILED_STEPS" -gt 0 ]; then
    echo -e "  ${VERMELHO}Atenção: $FAILED_STEPS passo(s) com falha — revise o log.${RESET}"
  fi
  echo -e "${AMARELO}===================================================================================================${RESET}"
}

# =============================================================================
# Main
# =============================================================================
main() {
  mkdir -p "$STATE_DIR"
  : > "$LOG_FILE"
  log "=== IMPA Migrator start ==="

  banner
  echo -e "${BRANCO}Este migrador reconstrói um ambiente SetupOrion (Docker Swarm) em uma VPS nova.${RESET}"
  echo -e "${BRANCO}Não clona o sistema operacional. Destino deve estar limpo.${RESET}"
  echo ""
  if ! confirm_yn "Você leu e aceita os requisitos (Debian/Ubuntu, destino limpo, mesma arch)"; then
    die "Aceite necessário para continuar."
  fi

  require_root
  validate_origin_os
  require_docker_swarm
  discovery
  show_inventory

  if ! confirm_yn "Inventário correto? Continuar para configurar o destino"; then
    die "Cancelado pelo usuário."
  fi

  ask_destination
  preflight_destination
  show_summary_and_confirm

  provision_destination
  freeze_origin
  transfer_all
  restore_stacks
  validate_migration
  final_report

  log "=== IMPA Migrator end ==="
}

main "$@"
