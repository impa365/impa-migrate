#!/bin/bash
# IMPA Migrator — migra Docker Swarm / Portainer / stacks / volumes entre VPS
# Rode na VPS de ORIGEM: sudo ./impa-migrator.sh
#                          bash <(curl -sSL https://migrator.impa365.com)

set -o pipefail

IMPA_MIGRATOR_VERSION="1.1.19"

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
EXPORTED_STACKS_DIR="$STATE_DIR/exported_stacks"
EXPORTED_STACKS_LIST="$STATE_DIR/exported_stacks.txt"
PORTAINER_DEPLOY_FILE="$STATE_DIR/portainer_deploy.txt"
REPLICAS_FILE="$STATE_DIR/replicas.txt"
PORTAINER_EXPORT_COUNT=0
PORTAINER_DEPLOY_COUNT=0

DEST_IP=""
DEST_USER="root"
DEST_AUTH_MODE=""   # key | password
DEST_SSH_KEY=""
DEST_PASSWORD=""
DEST_KNOWN_HOSTS=""
SSH_OPTS=(-o ConnectTimeout=15 -o ServerAliveInterval=30)
SSH_BASE=()
SCP_BASE=()

ORIGIN_OS=""
ORIGIN_VERSION=""
ORIGIN_ARCH=""
ORIGIN_SWARM=""
ORIGIN_MODE=""      # cutover | test
TOTAL_BYTES=0
TOTAL_HUMAN="0B"
ROOT_BYTES=0
ROOT_HUMAN="0B"
ESTIMATED_MIN=0
PORTAINER_URL=""
PORTAINER_USER=""
PORTAINER_PASS=""
PORTAINER_DEST_DOMAIN=""
PORTAINER_ORIG_DOMAIN=""
PORTAINER_TEMP_BOOTSTRAP=""
ORIGIN_PUBLIC_IP=""
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
  echo -e "${VERMELHO}Migração abortada. A VPS de origem NÃO foi destruída.${RESET}"
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

show_version() {
  echo -e " ${BRANCO}Versão do IMPA Migrator: ${VERDE}v. ${IMPA_MIGRATOR_VERSION}${RESET}"
  echo -e " ${CIANO}https://impa365.com${RESET}  ·  ${CIANO}https://github.com/impa365/impa-migrate${RESET}"
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
  echo -e "${AMARELO}=${RESET}  ${CIANO}Migração Docker  ·  Swarm + Portainer + Stacks + Volumes${RESET}                                      ${AMARELO}=${RESET}"
  echo -e "${AMARELO}=${RESET}  ${BRANCO}v. ${IMPA_MIGRATOR_VERSION}  ·  IMPA 365${RESET}                                                                    ${AMARELO}=${RESET}"
  echo -e "${AMARELO}=${RESET}                                                                                                 ${AMARELO}=${RESET}"
  echo -e "${AMARELO}===================================================================================================${RESET}"
  echo ""
  show_version
  echo ""
}

direitos_impa() {
  echo -e "${AMARELO}===================================================================================================${RESET}"
  echo -e "${AMARELO}=${RESET}                                                                                                 ${AMARELO}=${RESET}"
  echo -e "${AMARELO}=${RESET}  ${BRANCO}Este migrador foi desenvolvido pela IMPA 365 para auxiliar na migração de ambientes Docker${RESET}   ${AMARELO}=${RESET}"
  echo -e "${AMARELO}=${RESET}  ${BRANCO}(Swarm, Portainer, stacks e volumes) entre VPS — sem clonar o sistema operacional.${RESET}           ${AMARELO}=${RESET}"
  echo -e "${AMARELO}=${RESET}                                                                                                 ${AMARELO}=${RESET}"
  echo -e "${AMARELO}=${RESET}  ${BRANCO}Você pode usar, copiar, modificar e distribuir. Ao utilizar, mantenha os créditos:${RESET}            ${AMARELO}=${RESET}"
  echo -e "${AMARELO}=${RESET}  ${CIANO}IMPA 365${RESET} ${BRANCO}—${RESET} ${CIANO}https://impa365.com${RESET}  ${BRANCO}|${RESET}  ${CIANO}https://github.com/impa365/impa-migrate${RESET}                  ${AMARELO}=${RESET}"
  echo -e "${AMARELO}=${RESET}                                                                                                 ${AMARELO}=${RESET}"
  echo -e "${AMARELO}=${RESET}  ${BRANCO}Não é necessário ter instalado com nenhuma ferramenta específica. Serve para VPS com${RESET}         ${AMARELO}=${RESET}"
  echo -e "${AMARELO}=${RESET}  ${BRANCO}Docker Swarm (Portainer opcional). Destino deve ser Debian/Ubuntu limpo, mesma arquitetura.${RESET} ${AMARELO}=${RESET}"
  echo -e "${AMARELO}=${RESET}                                                                                                 ${AMARELO}=${RESET}"
  echo -e "${AMARELO}=${RESET}  ${BRANCO}Você é o responsável pelos seus dados, backups e pelo uso deste software.${RESET}                    ${AMARELO}=${RESET}"
  echo -e "${AMARELO}=${RESET}                                                                                                 ${AMARELO}=${RESET}"
  echo -e "${AMARELO}===================================================================================================${RESET}"
  echo ""
}

accept_credits() {
  direitos_impa
  if ! confirm_yn "Ao digitar Y você aceita e concorda com as orientações acima"; then
    clear 2>/dev/null || true
    echo "Que pena que você não concorda. Encerrando o migrador."
    exit 1
  fi
}

# Backup fortemente recomendado — 3 confirmações se recusar
backup_gate() {
  step "Backup da VPS de origem"
  echo -e "${VERMELHO}É ALTAMENTE RECOMENDADO fazer backup completo da VPS de origem antes de migrar.${RESET}"
  echo -e "${BRANCO}Snapshot na provedora, backup dos volumes ou imagem da VPS.${RESET}"
  echo ""

  if confirm_yn "Você já fez (ou fará agora) o backup antes de continuar"; then
    ok "Backup confirmado pelo usuário"
    log "BACKUP: user confirmed yes"
    return 0
  fi

  warn "Você indicou que NÃO tem backup."
  if ! confirm_yn "Tem certeza que deseja continuar SEM backup"; then
    die "Faça o backup e execute o migrador novamente."
  fi

  echo ""
  echo -e "${VERMELHO}Última confirmação.${RESET}"
  if ! confirm_yn "Tem CERTEZA absoluta de seguir SEM backup (terceira e última vez)"; then
    die "Faça o backup e execute o migrador novamente."
  fi

  echo ""
  echo -e "${VERMELHO}Ok. Seguindo por sua conta e risco — sem backup confirmado.${RESET}"
  log "BACKUP: user declined three times — proceeding at own risk"
  sleep 2
}

choose_origin_mode() {
  step "Modo de migração (VPS antiga)"
  echo -e "${BRANCO}Durante a cópia dos volumes a origem é pausada por alguns minutos (consistência de banco).${RESET}"
  echo ""
  echo -e "  ${AMARELO}[1]${RESET} ${BRANCO}Cutover (produção)${RESET}"
  echo -e "      Origem fica PAUSADA ao final. Ideal quando for apontar o DNS de vez."
  echo ""
  echo -e "  ${AMARELO}[2]${RESET} ${BRANCO}Teste (origem continua viva)${RESET}"
  echo -e "      Após a cópia, a origem é RELIGADA. Você aponta o DNS pro destino"
  echo -e "      na hora do Portainer (igual cutover), testa a VPS nova e pode"
  echo -e "      voltar o DNS pra origem se quiser."
  echo ""
  while true; do
    read -r -p "$(echo -e "${AMARELO}Escolha [1/2]: ${RESET}")" mode
    case "$mode" in
      1) ORIGIN_MODE="cutover"; ok "Modo: cutover (origem permanece pausada)"; break ;;
      2) ORIGIN_MODE="test"; ok "Modo: teste (origem será religada após a transferência)"; break ;;
      *) echo -e "${VERMELHO}Digite 1 ou 2.${RESET}" ;;
    esac
  done
}

# =============================================================================
# Dependências na origem (estilo SetupOrion — só o que faltar)
# =============================================================================
# pacote apt → binário esperado (vazio = só pacote)
ORIGIN_DEPS=(
  "curl:curl"
  "jq:jq"
  "sshpass:sshpass"
  "tar:tar"
  "ca-certificates:"
  "openssh-client:ssh"
  "pv:pv"
)

install_origin_deps() {
  step "Dependências na VPS de origem"
  echo -e "${BRANCO}Instala só o que ainda não existir (curl, jq, sshpass, tar, pv…).${RESET}"
  echo ""

  local missing=()
  local pkg bin
  for entry in "${ORIGIN_DEPS[@]}"; do
    pkg="${entry%%:*}"
    bin="${entry#*:}"
    if [ -n "$bin" ]; then
      if command -v "$bin" >/dev/null 2>&1; then
        ok "$bin já instalado"
      else
        missing+=("$pkg")
        info "Falta: $pkg"
      fi
    else
      if dpkg -s "$pkg" >/dev/null 2>&1; then
        ok "$pkg já instalado"
      else
        missing+=("$pkg")
        info "Falta: $pkg"
      fi
    fi
  done

  if [ ${#missing[@]} -eq 0 ]; then
    ok "Todas as dependências já estão presentes"
    return 0
  fi

  info "Instalando: ${missing[*]}"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null 2>&1 || true
  if ! apt-get install -y -qq "${missing[@]}" >/dev/null 2>&1; then
    die "Falha ao instalar dependências: ${missing[*]}. Rode: apt-get install -y ${missing[*]}"
  fi

  # Obrigatórios — pv é opcional (só barra de progresso)
  local required_bins=(curl jq sshpass tar ssh)
  for bin in "${required_bins[@]}"; do
    command -v "$bin" >/dev/null 2>&1 || die "Binário obrigatório ausente após install: $bin"
  done

  ok "Dependências instaladas"
}

# =============================================================================
# SSH helpers
# =============================================================================
sanitize_dest_known_hosts() {
  [ -n "$DEST_IP" ] || return 0
  mkdir -p "$STATE_DIR" "${HOME}/.ssh" 2>/dev/null || true
  DEST_KNOWN_HOSTS="$STATE_DIR/dest_known_hosts"
  : > "$DEST_KNOWN_HOSTS"
  chmod 600 "$DEST_KNOWN_HOSTS" 2>/dev/null || true

  # Entradas hasheadas não contêm o IP em texto — ssh-keygen -R sempre, sem grep
  local kh="${HOME}/.ssh/known_hosts"
  if [ -f "$kh" ]; then
    ssh-keygen -f "$kh" -R "$DEST_IP" >/dev/null 2>&1 || true
    ssh-keygen -f "$kh" -R "[${DEST_IP}]:22" >/dev/null 2>&1 || true
    ssh-keygen -f "$kh" -R "${DEST_USER}@${DEST_IP}" >/dev/null 2>&1 || true
    log "known_hosts: chaves antigas de ${DEST_IP} removidas (hash ou IP)"
  fi
}

ssh_dest_opts() {
  sanitize_dest_known_hosts
  echo "-o" "UserKnownHostsFile=${DEST_KNOWN_HOSTS}" "-o" "StrictHostKeyChecking=accept-new"
}

build_ssh() {
  local dest_kh_opts
  dest_kh_opts=$(ssh_dest_opts)
  SSH_BASE=(ssh "${SSH_OPTS[@]}" $dest_kh_opts)
  SCP_BASE=(scp "${SSH_OPTS[@]}" $dest_kh_opts)
  if [ "$DEST_AUTH_MODE" = "key" ]; then
    SSH_BASE+=(-i "$DEST_SSH_KEY")
    SCP_BASE+=(-i "$DEST_SSH_KEY")
  elif [ "$DEST_AUTH_MODE" = "password" ]; then
    command -v sshpass >/dev/null 2>&1 || die "sshpass ausente (deveria ter sido instalado no início)."
    export SSHPASS="$DEST_PASSWORD"
    SSH_BASE=(sshpass -e ssh "${SSH_OPTS[@]}" $dest_kh_opts -o PreferredAuthentications=password -o PubkeyAuthentication=no)
    SCP_BASE=(sshpass -e scp "${SSH_OPTS[@]}" $dest_kh_opts -o PreferredAuthentications=password -o PubkeyAuthentication=no)
  fi
}

remote() {
  # -n evita o SSH roubar stdin (quebrava loops e deploy parcial de stacks)
  "${SSH_BASE[@]}" -n "${DEST_USER}@${DEST_IP}" "$@"
}

remote_script() {
  # Heredoc / pipe → bash -s no destino (NÃO usar -n, senão o script chega vazio)
  "${SSH_BASE[@]}" "${DEST_USER}@${DEST_IP}" "$@"
}

remote_stream() {
  # Sem -n: usado quando stdin vem de pipe (tar | ssh …)
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
        20.04|22.04|23.04|23.10|24.04|24.10|25.04) ;;
        *) die "Ubuntu $ORIGIN_VERSION não homologado. Use Ubuntu 20.04+." ;;
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
  ORIGIN_PUBLIC_IP=$(curl -s --connect-timeout 4 https://api.ipify.org 2>/dev/null | tr -d '\r\n' || true)
  if [ -z "$ORIGIN_PUBLIC_IP" ]; then
    ORIGIN_PUBLIC_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  fi
  [ -n "$ORIGIN_PUBLIC_IP" ] && ok "IP público origem: $ORIGIN_PUBLIC_IP"
}

require_docker_swarm() {
  if ! command -v docker >/dev/null 2>&1; then
    die "Docker não encontrado na origem. Este migrador precisa de Docker com Swarm."
  fi
  ok "Docker instalado"

  ORIGIN_SWARM="$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || echo inactive)"
  if [ "$ORIGIN_SWARM" != "active" ]; then
    die "Docker Swarm não está ativo. Por enquanto só migrados ambientes Swarm (stacks). Compose puro: em breve."
  fi
  ok "Docker Swarm ativo"

  if ! docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qi 'portainer'; then
    warn "Portainer não detectado pelo nome — seguindo se houver stacks Swarm."
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
    die "Nenhuma stack Swarm encontrada. Nada para migrar neste modo."
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
    elif grep -qx portainer "$STACKS_FILE" 2>/dev/null; then
      warn "dados_portainer ausente — recomendamos SetupOrion; você definirá usuário/senha na migração"
    fi
  else
    warn "/root/dados_vps não encontrada"
    if grep -qx portainer "$STACKS_FILE" 2>/dev/null; then
      warn "Sem SetupOrion/dados_vps — você definirá o admin do Portainer durante a migração"
    fi
  fi

  # Tamanho útil de /root (YAMLs, dados_vps, scripts, etc.)
  ROOT_BYTES=$(du -sb /root --exclude=/root/.cache --exclude=/root/.local --exclude=/root/.npm 2>/dev/null | awk '{print $1}')
  ROOT_BYTES=${ROOT_BYTES:-0}
  ROOT_HUMAN=$(human_bytes "$ROOT_BYTES")
  ok "Conteúdo de /root a migrar: $ROOT_HUMAN"

  # Lista do Portainer = fonte da verdade do que ATIVAR no destino (YAML em /root só copia)
  if grep -qx portainer "$STACKS_FILE" 2>/dev/null; then
    export_stacks_from_portainer || die "Não foi possível listar stacks ativas do Portainer (obrigatório)."
    build_portainer_deploy_list
  else
    warn "Stack portainer ausente no Swarm — modo legado: ativa todas as stacks Swarm."
    : > "$PORTAINER_DEPLOY_FILE"
    while IFS= read -r s || [ -n "$s" ]; do
      [ -z "$s" ] && continue
      case "$s" in traefik|portainer) continue ;; esac
      echo "$s" >> "$PORTAINER_DEPLOY_FILE"
    done < "$STACKS_FILE"
    PORTAINER_DEPLOY_COUNT=$(wc -l < "$PORTAINER_DEPLOY_FILE" | tr -d ' ')
  fi

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
    echo "EXPORTED_PORTAINER=$PORTAINER_EXPORT_COUNT"
    echo "PORTAINER_DEPLOY=$PORTAINER_DEPLOY_COUNT"
    echo "TOTAL_BYTES=$TOTAL_BYTES"
    echo "TOTAL_HUMAN=$TOTAL_HUMAN"
  } > "$INVENTORY"

  echo ""
  ok "Dados totais: $TOTAL_HUMAN"
  ok "Tempo estimado: ~${ESTIMATED_MIN} min (depende da rede)"
}

# Exporta stacks ATIVAS do Portainer (Status=1). YAML em /root é copiado, mas só isso ativa no destino.
export_stacks_from_portainer() {
  step "Stacks ativas no Portainer (fonte da verdade para deploy)"
  mkdir -p "$EXPORTED_STACKS_DIR"
  : > "$EXPORTED_STACKS_LIST"
  PORTAINER_EXPORT_COUNT=0

  if ! command -v jq >/dev/null 2>&1; then
    die "jq obrigatório para listar stacks do Portainer."
  fi

  if [ -z "$PORTAINER_USER" ] || [ -z "$PORTAINER_PASS" ]; then
    die "Credenciais do Portainer ausentes — necessárias para saber quais stacks ativar."
  fi

  local bases=()
  local u
  if [ -n "$PORTAINER_URL" ]; then
    u="${PORTAINER_URL#https://}"
    u="${u#http://}"
    u="${u%/}"
    bases+=("https://$u" "http://$u")
  fi
  # Acesso local (funciona mesmo se DNS ainda for externo)
  bases+=("https://127.0.0.1:9443" "http://127.0.0.1:9000" "https://localhost:9443" "http://localhost:9000")

  local base token=""
  for base in "${bases[@]}"; do
    token=$(curl -k -s --connect-timeout 5 -X POST "$base/api/auth" \
      -H "Content-Type: application/json" \
      -d "{\"username\":\"$PORTAINER_USER\",\"password\":\"$PORTAINER_PASS\"}" 2>/dev/null \
      | jq -r '.jwt // empty' 2>/dev/null || true)
    if [ -n "$token" ] && [ "$token" != "null" ]; then
      ok "Portainer API autenticada em $base"
      break
    fi
    token=""
  done

  if [ -z "$token" ]; then
    die "Não autenticou no Portainer — confira dados_portainer."
  fi

  local stacks_json
  stacks_json=$(curl -k -s --connect-timeout 10 -H "Authorization: Bearer $token" "$base/api/stacks" 2>/dev/null || true)
  if [ -z "$stacks_json" ] || ! echo "$stacks_json" | jq -e 'type == "array"' >/dev/null 2>&1; then
    die "Resposta inválida de /api/stacks no Portainer."
  fi

  local count active_count
  count=$(echo "$stacks_json" | jq 'length')
  active_count=$(echo "$stacks_json" | jq '[.[] | select(.Status == 1)] | length')
  info "Portainer: $count stack(s) cadastrada(s), $active_count ativa(s) — exportando ativas..."

  local i id name status file_json content outfile
  for i in $(seq 0 $((count - 1))); do
    id=$(echo "$stacks_json" | jq -r ".[$i].Id")
    name=$(echo "$stacks_json" | jq -r ".[$i].Name")
    status=$(echo "$stacks_json" | jq -r ".[$i].Status // 0")
    [ -z "$id" ] || [ "$id" = "null" ] && continue
    [ -z "$name" ] || [ "$name" = "null" ] && continue

    if [ "$status" != "1" ]; then
      info "  Pulando $name (inativa no Portainer, Status=$status)"
      continue
    fi

    file_json=$(curl -k -s --connect-timeout 15 -H "Authorization: Bearer $token" \
      "$base/api/stacks/${id}/file" 2>/dev/null || true)
    content=$(echo "$file_json" | jq -r '.StackFileContent // empty' 2>/dev/null || true)

    # Fallback: alguns Portainer embutem o conteúdo na listagem
    if [ -z "$content" ]; then
      content=$(echo "$stacks_json" | jq -r ".[$i].StackFileContent // empty" 2>/dev/null || true)
    fi

    if [ -z "$content" ]; then
      warn "  Sem conteúdo compose: $name (id=$id)"
      continue
    fi

    outfile="$EXPORTED_STACKS_DIR/${name}.yaml"
    printf '%s\n' "$content" > "$outfile"
    echo "$name" >> "$EXPORTED_STACKS_LIST"
    PORTAINER_EXPORT_COUNT=$((PORTAINER_EXPORT_COUNT + 1))

    if [ -f "/root/${name}.yaml" ] || [ -f "/root/${name}.yml" ]; then
      ok "  $name (ativa no Portainer — compose da API tem prioridade sobre /root)"
    else
      ok "  $name (ativa no Portainer — compose exportado)"
    fi
  done

  if [ "$PORTAINER_EXPORT_COUNT" -eq 0 ]; then
    warn "Nenhuma stack ativa no Portainer (só traefik/portainer ou ambiente vazio)."
  else
    ok "$PORTAINER_EXPORT_COUNT stack(s) ativa(s) no Portainer — compose salvo para o destino"
  fi
  return 0
}

# Apps a ativar no destino = ativas no Portainer, exceto traefik/portainer (infra via docker CLI).
build_portainer_deploy_list() {
  : > "$PORTAINER_DEPLOY_FILE"
  while IFS= read -r name || [ -n "$name" ]; do
    [ -z "$name" ] && continue
    case "$name" in
      traefik|portainer) continue ;;
    esac
    echo "$name" >> "$PORTAINER_DEPLOY_FILE"
  done < "$EXPORTED_STACKS_LIST"

  PORTAINER_DEPLOY_COUNT=$(wc -l < "$PORTAINER_DEPLOY_FILE" | tr -d ' ')
  ok "$PORTAINER_DEPLOY_COUNT app(s) serão ativadas no Portainer do destino"

  local swarm_n yaml_n
  swarm_n=$(wc -l < "$STACKS_FILE" | tr -d ' ')
  if [ "$swarm_n" -gt "$((PORTAINER_DEPLOY_COUNT + 2))" ]; then
    info "Swarm rodava $swarm_n stacks — só as ativas no Portainer serão ativadas no destino"
  fi
  yaml_n=$(wc -l < "$YAML_LIST" | tr -d ' ')
  if [ "$yaml_n" -gt "$PORTAINER_DEPLOY_COUNT" ]; then
    info "$yaml_n YAML(s) em /root serão copiados (extras não são ativados automaticamente)"
  fi
}

show_inventory() {
  echo -e "${AMARELO}──────────────────────────────────────────────────────────────────────────────${RESET}"
  echo -e "${BRANCO}  INVENTÁRIO DA ORIGEM${RESET}"
  echo -e "${AMARELO}──────────────────────────────────────────────────────────────────────────────${RESET}"
  echo -e "  SO:           ${CIANO}$ORIGIN_OS $ORIGIN_VERSION${RESET} ($ORIGIN_ARCH)"
  echo -e "  Swarm:        ${CIANO}$ORIGIN_SWARM${RESET}"
  echo -e "  Stacks Swarm: ${CIANO}$(wc -l < "$STACKS_FILE" | tr -d ' ')${RESET} (rodando na origem)"
  while IFS= read -r s || [ -n "$s" ]; do
    [ -z "$s" ] && continue
    echo -e "                - $s"
  done < "$STACKS_FILE"
  echo -e "  Ativar no Portainer: ${CIANO}${PORTAINER_DEPLOY_COUNT:-0}${RESET}"
  if [ -f "$PORTAINER_DEPLOY_FILE" ] && [ -s "$PORTAINER_DEPLOY_FILE" ]; then
    while IFS= read -r s || [ -n "$s" ]; do
      [ -z "$s" ] && continue
      echo -e "                - $s"
    done < "$PORTAINER_DEPLOY_FILE"
  fi
  echo -e "  Redes:        ${CIANO}$(wc -l < "$NETWORKS_FILE" | tr -d ' ')${RESET}"
  while IFS= read -r n || [ -n "$n" ]; do
    [ -z "$n" ] && continue
    echo -e "                - $n"
  done < "$NETWORKS_FILE"
  echo -e "  Volumes:      ${CIANO}$(wc -l < "$VOLUMES_FILE" | tr -d ' ')${RESET}"
  echo -e "  Dados:        ${CIANO}$TOTAL_HUMAN${RESET}"
  echo -e "  YAMLs /root:  ${CIANO}$(wc -l < "$YAML_LIST" | tr -d ' ')${RESET}"
  echo -e "  Export Portainer: ${CIANO}${PORTAINER_EXPORT_COUNT}${RESET} ativa(s) (compose via API)"
  echo -e "  Pasta /root:  ${CIANO}${ROOT_HUMAN:-?}${RESET} (YAMLs, dados_vps e demais arquivos)"
  echo -e "${AMARELO}──────────────────────────────────────────────────────────────────────────────${RESET}"
  echo ""
}

# =============================================================================
# Destino — perguntas + preflight
# =============================================================================
prompt_dest_password() {
  local attempt label
  DEST_PASSWORD=""
  for attempt in 1 2 3; do
    label="Senha SSH de ${DEST_USER}@${DEST_IP}"
    if [ "$attempt" -gt 1 ]; then
      label="${label} (tentativa ${attempt}/3)"
    fi
    read -r -s -p "$(echo -e "${AMARELO}${label}: ${RESET}")" DEST_PASSWORD
    echo ""
    if [ -n "$DEST_PASSWORD" ]; then
      return 0
    fi
    warn "Senha vazia — tente de novo."
  done
  die "Senha não informada após 3 tentativas."
}

ask_destination() {
  step "Configurando VPS de destino"
  echo -e "${BRANCO}A VPS de destino DEVE ser nova/limpa (Debian 11–13 ou Ubuntu 20.04+), sem Docker.${RESET}"
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
        prompt_dest_password
        break
        ;;
      *) echo -e "${VERMELHO}Digite 1 ou 2.${RESET}" ;;
    esac
  done

  build_ssh
}

preflight_destination() {
  step "Preflight na VPS de destino ($DEST_IP)"

  local ssh_try=0 ssh_err=""
  while [ "$ssh_try" -lt 3 ]; do
    build_ssh
    ssh_err=$(remote "echo ok" 2>&1) && break
    ssh_try=$((ssh_try + 1))

    if echo "$ssh_err" | grep -qiE 'host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED'; then
      warn "Chave SSH do destino mudou (VPS restaurada/reinstalada) — limpando known_hosts…"
      sanitize_dest_known_hosts
      build_ssh
      if ssh_err=$(remote "echo ok" 2>&1); then
        break
      fi
    fi

    if [ "$ssh_try" -ge 3 ]; then
      die "Falha ao conectar via SSH em ${DEST_USER}@${DEST_IP} após 3 tentativas."
    fi
    warn "Não conectou em ${DEST_USER}@${DEST_IP}."
    if [ -n "$ssh_err" ]; then
      warn "SSH: $(echo "$ssh_err" | tail -2 | tr '\n' ' ' | sed 's/  */ /g')"
    fi
    if [ "$DEST_AUTH_MODE" = "password" ]; then
      if echo "$ssh_err" | grep -qiE 'host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED'; then
        echo -e "${BRANCO}Causa: chave SSH antiga do destino. O script já limpou — tente de novo.${RESET}"
      else
        echo -e "${BRANCO}Verifique IP, usuário e senha — você pode tentar de novo.${RESET}"
      fi
      sanitize_dest_known_hosts
      prompt_dest_password
    else
      die "Verifique a chave SSH e o acesso a ${DEST_USER}@${DEST_IP}."
    fi
  done
  ok "SSH conectado"

  local remote_check
  remote_check=$(remote_script 'bash -s' <<'REMOTE'
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

  if [ -z "$dest_os" ] || [ "$dest_os" = "OS_FAIL" ]; then
    die "Não detectou SO no destino (esperado Debian/Ubuntu). Saída SSH: $(echo "$remote_check" | tr '\n' ' ' | head -c 200)"
  fi

  case "$dest_os" in
    debian)
      case "$dest_ver" in
        11|12|13) ok "Destino: Debian $dest_ver" ;;
        *) die "Debian $dest_ver no destino não homologado." ;;
      esac
      ;;
    ubuntu)
      case "$dest_ver" in
        20.04|22.04|23.04|23.10|24.04|24.10|25.04) ok "Destino: Ubuntu $dest_ver" ;;
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
  echo -e "  Stacks Swarm: $(wc -l < "$STACKS_FILE" | tr -d ' ')"
  echo -e "  Ativar Portainer: ${PORTAINER_DEPLOY_COUNT:-0} app(s)"
  echo -e "  Volumes:  $(wc -l < "$VOLUMES_FILE" | tr -d ' ')  ($TOTAL_HUMAN)"
  echo -e "  Redes:    $(wc -l < "$NETWORKS_FILE" | tr -d ' ')"
  echo -e "  YAMLs /root: $(wc -l < "$YAML_LIST" | tr -d ' ') (copiados; extras não ativam)"
  echo -e "  Portainer ativas: ${PORTAINER_EXPORT_COUNT} stack(s)"
  echo -e "  /root:    ${ROOT_HUMAN:-?}"
  if [ "$ORIGIN_MODE" = "test" ]; then
    echo -e "  Modo:     ${CIANO}TESTE${RESET} (origem será religada)"
  else
    echo -e "  Modo:     ${CIANO}CUTOVER${RESET} (origem permanece pausada)"
  fi
  echo -e "  Tempo:    ~${ESTIMATED_MIN} min"
  echo ""
  echo -e "  ${AMARELO}O que acontece:${RESET}"
  echo -e "  1. Instala Docker + Swarm no destino"
  echo -e "  2. Envia YAMLs/dados_vps, sobe Traefik/Portainer (domínio do Portainer → destino)"
  echo -e "  3. Pausa origem e transfere volumes (consistência de banco)"
  echo -e "  4. Ativa no Portainer só as stacks que estavam ativas na origem (YAML extra em /root só copia)"
  if [ "$ORIGIN_MODE" = "test" ]; then
    echo -e "  6. RELIGA a origem — pode voltar o DNS pra origem depois de testar"
  else
    echo -e "  6. Origem permanece pausada (intacta para rollback)"
  fi
  echo -e "  ${AMARELO}Obs:${RESET} portainer_data NÃO é clonado (Swarm ID novo)."
  echo -e "       Traefik/Portainer sobem via docker stack deploy (podem ficar Limited — normal)."
  echo -e "       Demais stacks sobem via API do Portainer (controle total, como SetupOrion)."
  echo ""
  detect_portainer_origin_domain
  echo -e "  ${AMARELO}DNS Portainer:${RESET} na etapa bootstrap — mesmo domínio ou temporário novo"
  echo -e "       Origem hoje: ${CIANO}${PORTAINER_ORIG_DOMAIN}${RESET} → ${DEST_IP}"
  if [ "$ORIGIN_MODE" = "test" ]; then
    echo -e "       (modo teste: no final pode reverter DNS; domínio temp. evita mexer no A record da origem)"
  fi
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

  remote_script 'bash -s' <<'REMOTE' || die "Falha ao instalar Docker no destino"
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg lsb-release tar jq >/dev/null
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable docker
systemctl start docker
docker --version
REMOTE
  ok "Docker instalado no destino"

  remote_script 'bash -s' <<REMOTE || die "Falha ao iniciar Swarm no destino"
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
  local vol_total vol_i
  vol_total=$(wc -l < "$VOLUMES_FILE" | tr -d ' ')
  vol_i=0
  while IFS= read -r vol || [ -n "$vol" ]; do
    [ -z "$vol" ] && continue
    vol_i=$((vol_i + 1))
    echo -e "${AMARELO}[$vol_i/$vol_total]${RESET} ${BRANCO}$vol${RESET}"
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
# Freeze / unfreeze origem
# =============================================================================
freeze_origin() {
  step "Pausando stacks na origem (consistência de dados)"
  if [ "$ORIGIN_MODE" = "test" ]; then
    warn "Modo TESTE: pausa temporária — a origem será religada depois da cópia."
  else
    warn "Modo CUTOVER: a origem ficará pausada ao final (dados intactos)."
  fi

  : > "$REPLICAS_FILE"

  while IFS= read -r stack || [ -n "$stack" ]; do
    [ -z "$stack" ] && continue
    info "Pausando stack: $stack"
    local services
    services=$(docker stack services "$stack" --format '{{.Name}}' 2>/dev/null || true)
    if [ -z "$services" ]; then
      warn "Nenhum serviço em $stack"
      continue
    fi
    while IFS= read -r svc || [ -n "$svc" ]; do
      [ -z "$svc" ] && continue
      local replicas
      replicas=$(docker service inspect "$svc" --format '{{if .Spec.Mode.Replicated}}{{.Spec.Mode.Replicated.Replicas}}{{else}}1{{end}}' 2>/dev/null || echo 1)
      replicas=${replicas:-1}
      echo "${svc} ${replicas}" >> "$REPLICAS_FILE"
      if docker service scale "${svc}=0" >/dev/null 2>&1; then
        ok "  $svc → 0 (era $replicas)"
      else
        docker service update --replicas 0 "$svc" >/dev/null 2>&1 && ok "  $svc → 0 (era $replicas)" || off "  Falha ao pausar $svc"
      fi
    done <<< "$services"
  done < "$STACKS_FILE"

  info "Aguardando flush de I/O (10s)..."
  sleep 10
  ok "Origem pausada"
}

unfreeze_origin() {
  step "Religando stacks na origem (modo teste)"
  if [ ! -s "$REPLICAS_FILE" ]; then
    warn "Sem mapa de replicas salvo — tentando scale=1 em todos os serviços das stacks"
    while IFS= read -r stack || [ -n "$stack" ]; do
      [ -z "$stack" ] && continue
      local services
      services=$(docker stack services "$stack" --format '{{.Name}}' 2>/dev/null || true)
      while IFS= read -r svc || [ -n "$svc" ]; do
        [ -z "$svc" ] && continue
        docker service scale "${svc}=1" >/dev/null 2>&1 && ok "  $svc → 1" || warn "  Falha ao religar $svc"
      done <<< "$services"
    done < "$STACKS_FILE"
    return 0
  fi

  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    local svc replicas
    svc=$(echo "$line" | awk '{print $1}')
    replicas=$(echo "$line" | awk '{print $2}')
    replicas=${replicas:-1}
    [ "$replicas" -lt 1 ] 2>/dev/null && replicas=1
    if docker service scale "${svc}=${replicas}" >/dev/null 2>&1; then
      ok "  $svc → $replicas"
    else
      warn "  Falha ao religar $svc"
    fi
  done < "$REPLICAS_FILE"
  ok "Origem religada — você pode apontar DNS para a nova e voltar se quiser"
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
  # Clonar portainer_data deixa a UI órfã. As stacks sobem pelo export da API + YAMLs.
  if [ "$vol" = "portainer_data" ]; then
    warn "Pulando conteúdo de portainer_data (Swarm ID muda)"
    warn "Compose: ${PORTAINER_EXPORT_COUNT} ativa(s) no Portainer + YAMLs em /root (só ativas são deployadas)"
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
      if tar -C "$src" -cf - . 2>/dev/null | pv -s "$size" | remote_stream "mkdir -p /var/lib/docker/volumes/${vol}/_data && tar -C /var/lib/docker/volumes/${vol}/_data -xf -"; then
        ok "Volume $vol transferido"
        return 0
      fi
    else
      if tar -C "$src" -cf - . 2>/dev/null | remote_stream "mkdir -p /var/lib/docker/volumes/${vol}/_data && tar -C /var/lib/docker/volumes/${vol}/_data -xf -"; then
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
  step "Transferindo pasta /root"
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
        | remote_stream "tar -C /root -xf -"; then
        ok "Pasta /root transferida ($ROOT_HUMAN)"
        # Sanity checks
        remote "test -d /root/dados_vps" && ok "dados_vps presente no destino" || warn "dados_vps não encontrado no destino"
        local yaml_dest
        yaml_dest=$(remote "ls /root/*.yaml /root/*.yml 2>/dev/null | wc -l" | tr -d ' \r' || echo 0)
        ok "YAMLs no destino: $yaml_dest"
        return 0
      fi
    else
      if tar -C /root "${excludes[@]}" -cf - . 2>/dev/null \
        | remote_stream "tar -C /root -xf -"; then
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
  fix_supabase_permissions_contingency
}

transfer_root_preflight() {
  step "Enviando /root para o destino (YAMLs + dados_vps)"
  echo -e "${BRANCO}Antes do freeze — só configuração, para subir Traefik/Portainer.${RESET}"
  transfer_root || die "Falha ao enviar /root para o destino."
  transfer_exported_stacks || die "Falha ao enviar compose do Portainer (prioridade sobre /root)."
  fix_supabase_permissions_contingency
}

transfer_exported_stacks() {
  step "Enviando stacks exportadas do Portainer"
  if [ ! -d "$EXPORTED_STACKS_DIR" ] || [ "$PORTAINER_EXPORT_COUNT" -eq 0 ]; then
    warn "Nenhuma stack exportada para enviar"
    return 0
  fi

  remote "mkdir -p /root/impa-exported-stacks"

  if tar -C "$EXPORTED_STACKS_DIR" -cf - . 2>/dev/null \
    | remote_stream "tar -C /root/impa-exported-stacks -xf -"; then
    ok "Pacote Portainer enviado ($PORTAINER_EXPORT_COUNT stack(s))"
  else
    off "Falha ao enviar stacks exportadas do Portainer"
    return 1
  fi

  local name
  while IFS= read -r name || [ -n "$name" ]; do
    [ -z "$name" ] && continue
    if remote "test -f /root/impa-exported-stacks/${name}.yaml"; then
      if remote "test -f /root/${name}.yaml -o -f /root/${name}.yml"; then
        remote "cp /root/impa-exported-stacks/${name}.yaml /root/${name}.yaml" \
          && ok "  $name → Portainer sobrescreve /root (compose mais recente)" \
          || off "  Falha ao priorizar Portainer para $name"
      else
        remote "cp /root/impa-exported-stacks/${name}.yaml /root/${name}.yaml" \
          && ok "  $name → /root/${name}.yaml (veio do Portainer)" \
          || off "  Falha ao copiar $name para /root"
      fi
    else
      warn "  $name exportado mas YAML ausente em impa-exported-stacks"
    fi
  done < "$EXPORTED_STACKS_LIST"
}

# Após tar /root ou volumes entre VPS, UIDs numéricos divergem (_apt=105 na origem, 100 no destino).
# O Postgres do Supabase lê pgsodium_root.key em supabase_db_config — sem isso: "invalid secret key".
fix_supabase_permissions_contingency() {
  remote "test -d /root/supabase/docker/volumes/db/data" 2>/dev/null || return 0

  info "Contingência Supabase: alinhando UID/GID de bind mounts e supabase_db_config"
  local out rc=0
  out=$(remote_script 'bash -s' <<'REMOTE' 2>&1) || rc=$?
set -euo pipefail

DATA_DIR="/root/supabase/docker/volumes/db/data"
CONFIG_DIR="/var/lib/docker/volumes/supabase_db_config/_data"
STORAGE_DIR="/root/supabase/docker/volumes/storage"

if [ ! -d "$DATA_DIR" ]; then
  echo "SKIP"
  exit 0
fi

if [ -f "$DATA_DIR/PG_VERSION" ]; then
  read -r PG_UID PG_GID < <(stat -c '%u %g' "$DATA_DIR/PG_VERSION")
elif [ -d "$DATA_DIR/base" ]; then
  read -r PG_UID PG_GID < <(stat -c '%u %g' "$DATA_DIR/base")
else
  read -r PG_UID PG_GID < <(stat -c '%u %g' "$DATA_DIR")
fi

# Fallback: _apt na origem SetupOrion/Supabase costuma ser 105
if [ -z "${PG_UID:-}" ] || [ "$PG_UID" -eq 0 ]; then PG_UID=105; fi
if [ -z "${PG_GID:-}" ] || [ "$PG_GID" -eq 0 ]; then PG_GID=104; fi

if [ -d "$CONFIG_DIR" ]; then
  chown -R "${PG_UID}:${PG_GID}" "$CONFIG_DIR"
  [ -f "$CONFIG_DIR/pgsodium_root.key" ] && chmod 600 "$CONFIG_DIR/pgsodium_root.key"
fi

chown -R "${PG_UID}:${PG_GID}" "$DATA_DIR"

if [ -d "$STORAGE_DIR" ]; then
  chown -R "${PG_UID}:${PG_GID}" "$STORAGE_DIR"
fi

# Diagnóstico: mismatch nomeado (uid 105 = tcpdump no destino, _apt na origem)
local_name=""
local_name=$(getent passwd "$PG_UID" 2>/dev/null | cut -d: -f1 || true)
echo "OK uid=${PG_UID} gid=${PG_GID} local_user=${local_name:-?}"
REMOTE
) || rc=$?

  if [ "$rc" -eq 0 ] && echo "$out" | grep -q '^OK '; then
    ok "Supabase: $(echo "$out" | grep '^OK ' | tail -1 | sed 's/^OK //')"
    return 0
  fi
  if echo "$out" | grep -qx 'SKIP'; then
    return 0
  fi
  warn "Contingência Supabase (não bloqueante): $(echo "$out" | tail -2 | tr '\n' ' ')"
  return 0
}

# =============================================================================
# Restore stacks
# =============================================================================
# Traefik v3.5 + Docker 29 quebra o provider Swarm (API 1.24 vs 1.40+) → 404 em tudo.
patch_traefik_for_modern_docker() {
  step "Ajustando Traefik para Docker 29+"
  remote_script 'bash -s' <<'PATCH' || { warn "Não foi possível ajustar traefik.yaml"; return 1; }
set -e
[ -f /root/traefik.yaml ] || exit 0
python3 <<'PY'
from pathlib import Path
import re

p = Path("/root/traefik.yaml")
t = p.read_text(encoding="utf-8")
orig = t

if not re.search(r"traefik:v3\.(?:6|7)", t):
    t = re.sub(r"image:\s*traefik:v[\d.]+", "image: traefik:v3.6.1", t)

net_m = re.search(r'--providers\.docker\.network=([^\s"]+)', t)
swarm_net_m = re.search(r'--providers\.swarm\.network=([^\s"]+)', t)
network = (swarm_net_m or net_m).group(1) if (swarm_net_m or net_m) else "OrionNet"

# Traefik v3 removeu providers.docker.swarmMode — usar providers.swarm
t = re.sub(r'\s*- "--providers\.docker\.swarmMode=true"[^\n]*\n', "\n", t)
t = re.sub(r'\s*- "--providers\.docker\.network=[^"]+"[^\n]*\n', "\n", t)
for rm in (
    '      - "--providers.docker.endpoint=unix:///var/run/docker.sock"\n',
    '      - "--providers.docker.exposedbydefault=false"\n',
):
    t = t.replace(rm, "")

t = t.replace(
    '      - "--providers.docker.network=OrionNet" ## Nome da rede interna\n', ""
)
t = t.replace('      - "--providers.docker.network=OrionNet"\n', "")

swarm_cfg = (
    f'      - "--providers.swarm=true"\n'
    f'      - "--providers.swarm.endpoint=unix:///var/run/docker.sock"\n'
    f'      - "--providers.swarm.exposedbydefault=false"\n'
    f'      - "--providers.swarm.network={network}"\n'
)
if "providers.swarm=true" not in t:
    if '      - "--api.dashboard=true"\n' in t:
        t = t.replace(
            '      - "--api.dashboard=true"\n',
            '      - "--api.dashboard=true"\n' + swarm_cfg,
            1,
        )
    else:
        t = t.replace("    command:\n", "    command:\n" + swarm_cfg, 1)
elif f"providers.swarm.network={network}" not in t:
    t = re.sub(
        r'\s*- "--providers\.swarm\.network=[^"]+"[^\n]*\n',
        f'      - "--providers.swarm.network={network}"\n',
        t,
        count=1,
    )

# Traefik v3 + Swarm provider: middlewares usam @swarm
t = t.replace("@docker", "@swarm")

if "DOCKER_API_VERSION" not in t:
    needle = '    volumes:\n      - "vol_certificates:/etc/traefik/letsencrypt"'
    insert = (
        "    environment:\n"
        "      - DOCKER_API_VERSION=1.45\n"
        "\n"
        "    volumes:\n"
        '      - "vol_certificates:/etc/traefik/letsencrypt"'
    )
    if needle in t:
        t = t.replace(needle, insert)

if t != orig:
    p.write_text(t, encoding="utf-8")
    print("PATCHED")
else:
    print("ALREADY_OK")
PY
PATCH
  ok "Traefik compatível com Docker 29+ (v3.6.1 + provider Swarm)"
}

deploy_stack_remote() {
  local name="$1"
  local file="$2"
  remote "test -f /root/$file" || { off "YAML ausente no destino: $file"; return 1; }
  if remote "docker stack deploy --prune --resolve-image always -c /root/$file $name"; then
    ok "Stack deploy (CLI): $name"
    return 0
  fi
  off "Falha deploy: $name"
  return 1
}

portainer_dest_domain() {
  [ -n "$PORTAINER_DEST_DOMAIN" ] && return 0
  local domain="${PORTAINER_URL#https://}"
  domain="${domain#http://}"
  domain="${domain%/}"
  if [ -z "$domain" ]; then
    domain=$(grep -oE 'Host\(`[^`]+`' /root/portainer.yaml /root/portainer.yml 2>/dev/null | head -1 | sed -E 's/.*Host\(`([^`]+)`.*/\1/' || true)
  fi
  if [ -z "$domain" ]; then
    domain=$(remote "grep -oE 'Host\\(\\\`[^\\\`]+\\\`\\)' /root/portainer.yaml /root/impa-exported-stacks/portainer.yaml 2>/dev/null | head -1 | sed -E 's/Host\\(\\\`([^\\\`]+)\\\`\\)/\\1/'" 2>/dev/null | tr -d '\r' || true)
  fi
  [ -z "$domain" ] && domain="portainer.local"
  PORTAINER_DEST_DOMAIN="$domain"
}

validate_domain_name() {
  local d="$1"
  [ -n "$d" ] || return 1
  [ "${#d}" -le 253 ] || return 1
  [[ "$d" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ ]]
}

detect_portainer_origin_domain() {
  local domain="${PORTAINER_URL#https://}"
  domain="${domain#http://}"
  domain="${domain%/}"
  if [ -z "$domain" ]; then
    domain=$(grep -oE 'Host\(`[^`]+`' /root/portainer.yaml /root/portainer.yml 2>/dev/null | head -1 | sed -E 's/.*Host\(`([^`]+)`.*/\1/' || true)
  fi
  [ -z "$domain" ] && domain="portainer.local"
  PORTAINER_ORIG_DOMAIN="$domain"
}

ask_portainer_bootstrap_domain() {
  detect_portainer_origin_domain
  step "Domínio do Portainer no destino (bootstrap)"
  echo -e "${BRANCO}Domínio na origem:${RESET} ${CIANO}${PORTAINER_ORIG_DOMAIN}${RESET}"
  echo ""
  echo -e "${BRANCO}Para criar o admin, o Traefik no destino precisa de um domínio com A record → ${DEST_IP}.${RESET}"
  echo -e "${BRANCO}Só o Portainer usa este domínio agora — apps mantêm os domínios originais.${RESET}"
  echo ""
  echo -e "  ${AMARELO}[1]${RESET} ${BRANCO}Mesmo domínio${RESET} — alterar o A record existente"
  echo -e "  ${AMARELO}[2]${RESET} ${BRANCO}Domínio temporário${RESET} — criar A record novo (recomendado)"
  echo ""

  while true; do
    local choice="" new_domain=""
    read -r -p "$(echo -e "${AMARELO}Escolha [1/2]: ${RESET}")" choice
    case "$choice" in
      1)
        PORTAINER_DEST_DOMAIN="$PORTAINER_ORIG_DOMAIN"
        PORTAINER_TEMP_BOOTSTRAP=""
        ok "Bootstrap Portainer em: $PORTAINER_DEST_DOMAIN"
        break
        ;;
      2)
        while true; do
          read -r -p "$(echo -e "${AMARELO}Domínio temporário (ex: portainer-migra.seudominio.com.br): ${RESET}")" new_domain
          new_domain=$(echo "$new_domain" | tr '[:upper:]' '[:lower:]' | tr -d ' ')
          new_domain="${new_domain#https://}"
          new_domain="${new_domain#http://}"
          new_domain="${new_domain%/}"
          if ! validate_domain_name "$new_domain"; then
            warn "Domínio inválido — use letras, números, pontos e hífens."
            continue
          fi
          if [ "$new_domain" = "$PORTAINER_ORIG_DOMAIN" ]; then
            warn "Igual ao da origem — use a opção [1]."
            continue
          fi
          break
        done
        PORTAINER_DEST_DOMAIN="$new_domain"
        PORTAINER_TEMP_BOOTSTRAP="yes"
        ok "Domínio temporário: $PORTAINER_DEST_DOMAIN"
        info "Crie o A record ${PORTAINER_DEST_DOMAIN} → ${DEST_IP} (sem alterar ${PORTAINER_ORIG_DOMAIN})"
        break
        ;;
      *)
        echo -e "${VERMELHO}Digite 1 ou 2.${RESET}"
        ;;
    esac
  done
}

apply_portainer_bootstrap_domain_on_dest() {
  [ "$PORTAINER_TEMP_BOOTSTRAP" = "yes" ] || return 0
  [ "$PORTAINER_DEST_DOMAIN" != "$PORTAINER_ORIG_DOMAIN" ] || return 0

  step "Aplicando domínio temporário no portainer.yaml (destino)"
  info "${PORTAINER_ORIG_DOMAIN} → ${PORTAINER_DEST_DOMAIN}"

  remote_script "OLD='$PORTAINER_ORIG_DOMAIN' NEW='$PORTAINER_DEST_DOMAIN' bash -s" <<'REMOTE' || die "Não foi possível atualizar portainer.yaml no destino."
set -euo pipefail
python3 <<'PY'
from pathlib import Path
import os
old = os.environ["OLD"]
new = os.environ["NEW"]
changed = False
for p in (
    Path("/root/portainer.yaml"),
    Path("/root/portainer.yml"),
    Path("/root/impa-exported-stacks/portainer.yaml"),
):
    if not p.is_file():
        continue
    text = p.read_text(encoding="utf-8")
    if old not in text:
        continue
    p.write_text(text.replace(old, new), encoding="utf-8")
    print(f"PATCHED:{p}")
    changed = True
if not changed:
    raise SystemExit("NO_MATCH")
PY
REMOTE

  ok "portainer.yaml no destino usa ${PORTAINER_DEST_DOMAIN}"
}

resolve_domain_a() {
  local domain="$1" ip=""
  if command -v getent >/dev/null 2>&1; then
    ip=$(getent ahosts "$domain" 2>/dev/null | awk '{print $1; exit}')
  fi
  if [ -z "$ip" ] && command -v dig >/dev/null 2>&1; then
    ip=$(dig +short A "$domain" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
  fi
  if [ -z "$ip" ] && command -v host >/dev/null 2>&1; then
    ip=$(host -t A "$domain" 2>/dev/null | awk '/has address/{print $4; exit}')
  fi
  echo "$ip"
}

is_cloudflare_ip() {
  case "$1" in
    104.*|172.67.*|173.245.*|141.101.*|108.162.*|190.93.*|188.114.*|197.234.*|198.41.*|162.158.*|103.21.*|103.22.*|103.31.*) return 0 ;;
    *) return 1 ;;
  esac
}

require_dns_to_dest() {
  local domain="$1"
  local ctx="${2:-DNS}"
  [ -n "$domain" ] || { portainer_dest_domain; domain="$PORTAINER_DEST_DOMAIN"; }
  [ -n "$domain" ] || return 0

  step "Verificando DNS — $ctx"
  echo -e "${BRANCO}Domínio:${RESET} ${CIANO}${domain}${RESET}"
  echo -e "${BRANCO}IP da VPS nova (destino):${RESET} ${CIANO}${DEST_IP}${RESET}"
  if [ -n "$ORIGIN_PUBLIC_IP" ]; then
    echo -e "${BRANCO}IP da VPS antiga (origem):${RESET} ${CIANO}${ORIGIN_PUBLIC_IP}${RESET}"
  fi
  echo ""
  echo -e "${VERMELHO}Altere o registro A de ${domain} para ${DEST_IP} (Hostinger/Cloudflare).${RESET}"
  if [ "$ORIGIN_MODE" = "test" ]; then
    echo -e "${BRANCO}Modo teste: DNS pro destino agora → migra → testa → no final a origem religa e você pode reverter o DNS.${RESET}"
  else
    echo -e "${BRANCO}Modo cutover: DNS fica no destino; a origem permanece pausada ao final.${RESET}"
  fi
  echo -e "${BRANCO}Aguarde a propagação. O script só continua quando ${domain} resolver para ${DEST_IP}.${RESET}"
  if [ "$PORTAINER_TEMP_BOOTSTRAP" = "yes" ]; then
    echo -e "${BRANCO}Domínio temporário só para o Portainer — ${PORTAINER_ORIG_DOMAIN} na origem não precisa mudar.${RESET}"
  fi
  echo ""

  while true; do
    local resolved
    resolved=$(resolve_domain_a "$domain")

    if [ "$resolved" = "$DEST_IP" ]; then
      ok "DNS OK: $domain → $DEST_IP"
      if remote "curl -sk -o /dev/null -w '%{http_code}' -H 'Host: $domain' https://127.0.0.1/ 2>/dev/null" | grep -qE '^(200|301|302|307|308|401|404|503)$'; then
        ok "Traefik no destino responde para Host: $domain"
      else
        warn "DNS OK, mas Traefik ainda não responde — aguardando stack estabilizar..."
        sleep 8
        if remote "curl -sk -o /dev/null -w '%{http_code}' -H 'Host: $domain' https://127.0.0.1/ 2>/dev/null" | grep -qE '^(200|301|302|307|308|401|404|503)$'; then
          ok "Traefik respondeu na segunda checagem"
        else
          warn "Traefik sem resposta — verifique traefik/portainer no destino após DNS OK"
        fi
      fi
      return 0
    fi

    if [ -n "$resolved" ] && is_cloudflare_ip "$resolved"; then
      warn "$domain → $resolved (Cloudflare proxy)"
      echo -e "${BRANCO}Com proxy laranja: no Cloudflare, o A record de ${domain} deve ser ${DEST_IP}.${RESET}"
      if confirm_yn "Já atualizei no Cloudflare — A record aponta para ${DEST_IP}"; then
        ok "DNS confirmado (Cloudflare proxy)"
        return 0
      fi
    elif [ -n "$resolved" ]; then
      warn "$domain → $resolved (esperado: ${DEST_IP})"
      if [ -n "$ORIGIN_PUBLIC_IP" ] && [ "$resolved" = "$ORIGIN_PUBLIC_IP" ]; then
        echo -e "${VERMELHO}Ainda aponta para a VPS ANTIGA — altere o A record para ${DEST_IP}.${RESET}"
      fi
    else
      warn "Não resolveu $domain (propagação ou registro ausente)"
    fi

    echo ""
    read -r -p "$(echo -e "${AMARELO}Alterou o DNS para ${DEST_IP}? Pressione ENTER para verificar de novo (Ctrl+C cancela): ${RESET}")" _
  done
}

# SetupOrion: apps via API do Portainer (controle total). Só traefik/portainer usam docker stack deploy.
init_portainer_dest_api() {
  step "Portainer API no destino (deploy estilo SetupOrion)"
  command -v jq >/dev/null 2>&1 || die "jq necessário na origem."

  if [ -z "$PORTAINER_USER" ] || [ -z "$PORTAINER_PASS" ]; then
    die "Credenciais Portainer ausentes — necessárias para deploy via API."
  fi

  remote "command -v jq >/dev/null 2>&1 || apt-get install -y -qq jq >/dev/null" \
    || die "Não foi possível instalar jq no destino."

  portainer_dest_domain
  info "Domínio Portainer (Host header): $PORTAINER_DEST_DOMAIN"

  local user_b64 pass_b64 result
  user_b64=$(printf '%s' "$PORTAINER_USER" | base64 -w0 2>/dev/null || printf '%s' "$PORTAINER_USER" | base64)
  pass_b64=$(printf '%s' "$PORTAINER_PASS" | base64 -w0 2>/dev/null || printf '%s' "$PORTAINER_PASS" | base64)

  result=$(remote_script "DOMAIN='$PORTAINER_DEST_DOMAIN' USER_B64='$user_b64' PASS_B64='$pass_b64' bash -s" <<'REMOTE'
set -euo pipefail
USER=$(echo "$USER_B64" | base64 -d)
PASS=$(echo "$PASS_B64" | base64 -d)
TOKEN=""
for _ in $(seq 1 12); do
  TOKEN=$(curl -sk -X POST -H "Content-Type: application/json" -H "Host: $DOMAIN" \
    -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" \
    https://127.0.0.1/api/auth 2>/dev/null | jq -r '.jwt // empty')
  [ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] && break
  sleep 5
done
[ -z "$TOKEN" ] && { echo "AUTH_FAIL"; exit 1; }

ENDPOINT_ID=$(curl -sk -H "Authorization: Bearer $TOKEN" -H "Host: $DOMAIN" \
  https://127.0.0.1/api/endpoints 2>/dev/null \
  | jq -r '.[] | select(.Name == "primary") | .Id')
SWARM_ID=$(curl -sk -H "Authorization: Bearer $TOKEN" -H "Host: $DOMAIN" \
  "https://127.0.0.1/api/endpoints/${ENDPOINT_ID}/docker/swarm" 2>/dev/null | jq -r '.ID')

TOKEN_B64=$(printf '%s' "$TOKEN" | base64 -w0 2>/dev/null || printf '%s' "$TOKEN" | base64)
cat > /tmp/impa-portainer-api.env <<ENVEOF
DOMAIN=$DOMAIN
TOKEN_B64=$TOKEN_B64
ENDPOINT_ID=$ENDPOINT_ID
SWARM_ID=$SWARM_ID
ENVEOF
chmod 600 /tmp/impa-portainer-api.env
echo "OK|$ENDPOINT_ID|$SWARM_ID"
REMOTE
) || die "Falha ao conectar na API do Portainer no destino."

  if [[ "$result" != OK* ]]; then
    die "Portainer API no destino: $result"
  fi
  ok "Portainer API pronta (endpoint $(echo "$result" | cut -d'|' -f2), swarm $(echo "$result" | cut -d'|' -f3 | cut -c1-12)…)"
}

deploy_stack_via_portainer() {
  local name="$1"
  local file="$2"
  remote "test -f /root/$file" || { off "YAML ausente no destino: $file"; return 1; }

  local out rc=0
  out=$(remote_script "NAME='$name' YAML='/root/$file' bash -s" <<'REMOTE' 2>&1
set -euo pipefail
source /tmp/impa-portainer-api.env
TOKEN=$(echo "$TOKEN_B64" | base64 -d)

STACK_ID=$(curl -sk -H "Authorization: Bearer $TOKEN" -H "Host: $DOMAIN" \
  https://127.0.0.1/api/stacks 2>/dev/null \
  | jq -r --arg n "$NAME" '.[] | select(.Name == $n) | .Id' | head -1)
if [ -n "$STACK_ID" ] && [ "$STACK_ID" != "null" ]; then
  curl -sk -X DELETE -H "Authorization: Bearer $TOKEN" -H "Host: $DOMAIN" \
    "https://127.0.0.1/api/stacks/${STACK_ID}?external=true&endpointId=${ENDPOINT_ID}" >/dev/null 2>&1 || true
  sleep 3
fi

if docker stack ls --format '{{.Name}}' 2>/dev/null | grep -qx "$NAME"; then
  docker stack rm "$NAME" >/dev/null 2>&1 || true
  sleep 10
fi

http_code=$(curl -sk -o /tmp/impa_stack_resp.json -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Host: $DOMAIN" \
  -F "Name=$NAME" \
  -F "file=@$YAML" \
  -F "SwarmID=$SWARM_ID" \
  -F "endpointId=$ENDPOINT_ID" \
  https://127.0.0.1/api/stacks/create/swarm/file)

if [ "$http_code" = "200" ] && grep -q '"Id"' /tmp/impa_stack_resp.json 2>/dev/null; then
  echo "OK"
  exit 0
fi
echo "HTTP_$http_code"
cat /tmp/impa_stack_resp.json 2>/dev/null || true
exit 1
REMOTE
) || rc=$?
  if [ "$rc" -eq 0 ] && echo "$out" | grep -qx "OK"; then
    ok "Stack via Portainer API: $name"
    return 0
  fi
  off "Falha deploy Portainer API: $name"
  [ -n "$out" ] && warn "$(echo "$out" | tail -3)"
  return 1
}

find_stack_yaml() {
  local stack="$1"
  # Portainer API = fonte da verdade (edições na UI nem sempre vão para /root)
  if remote "test -f /root/impa-exported-stacks/${stack}.yaml"; then
    echo "impa-exported-stacks/${stack}.yaml"
    return 0
  fi
  if remote "test -f /root/${stack}.yaml"; then
    echo "${stack}.yaml"
    return 0
  fi
  if remote "test -f /root/${stack}.yml"; then
    echo "${stack}.yml"
    return 0
  fi
  return 1
}

restore_stacks() {
  deploy_application_stacks
}

# Traefik/Portainer: docker stack deploy (Limited no Portainer é esperado).
# Apps: API do Portainer — igual SetupOrion stack_editavel /api/stacks/create/swarm/file
bootstrap_dest_infra() {
  step "Bootstrap no destino (estilo SetupOrion)"
  echo -e "${BRANCO}Traefik → Portainer → admin (docker CLI). Apps depois via API Portainer.${RESET}"
  echo ""

  ensure_portainer_credentials

  patch_traefik_for_modern_docker || true

  if grep -qx "traefik" "$STACKS_FILE" 2>/dev/null; then
    local yaml
    yaml=$(find_stack_yaml "traefik" 2>/dev/null || true)
    if [ -n "$yaml" ]; then
      deploy_stack_remote "traefik" "$yaml" || die "Falha ao subir Traefik no destino."
      info "Aguardando Traefik estabilizar (20s)..."
      sleep 20
    else
      die "traefik.yaml ausente no destino."
    fi
  else
    warn "Stack traefik não encontrada na origem — pulando."
  fi

  if grep -qx "portainer" "$STACKS_FILE" 2>/dev/null; then
    ask_portainer_bootstrap_domain
    apply_portainer_bootstrap_domain_on_dest
    local yaml
    yaml=$(find_stack_yaml "portainer" 2>/dev/null || true)
    if [ -n "$yaml" ]; then
      deploy_stack_remote "portainer" "$yaml" || die "Falha ao subir Portainer no destino."
      info "Aguardando Portainer (25s)..."
      sleep 25
      portainer_dest_domain
      require_dns_to_dest "$PORTAINER_DEST_DOMAIN" "Portainer (obrigatório antes do admin)"
      init_portainer_admin || die "Admin Portainer não criado — confira DNS, Traefik e logs do portainer."
    else
      die "portainer.yaml ausente no destino."
    fi
  else
    warn "Stack portainer não encontrada — deploy via API das demais stacks não será possível."
  fi

  ok "Infra pronta — Portainer inicializado"
}

deploy_application_stacks() {
  step "Restaurando stacks de aplicação no destino"
  echo -e "${BRANCO}Só stacks ativas no Portainer da origem — via API (SetupOrion).${RESET}"
  echo ""

  if [ ! -s "$PORTAINER_DEPLOY_FILE" ]; then
    warn "Nenhuma app para ativar no Portainer — pulando deploy de aplicações."
    return 0
  fi

  portainer_dest_domain
  require_dns_to_dest "$PORTAINER_DEST_DOMAIN" "Portainer (antes das apps)"

  init_portainer_dest_api

  local deployed_list="$STATE_DIR/deployed.txt"
  local failed_list="$STATE_DIR/deploy_failed.txt"
  : > "$deployed_list"
  : > "$failed_list"
  grep -qx "traefik" "$STACKS_FILE" 2>/dev/null && echo "traefik" >> "$deployed_list"
  grep -qx "portainer" "$STACKS_FILE" 2>/dev/null && echo "portainer" >> "$deployed_list"

  local stack_total deploy_i
  stack_total=$(wc -l < "$PORTAINER_DEPLOY_FILE" | tr -d ' ')
  deploy_i=0

  deploy_one_stack() {
    local name="$1"
    local yaml

    case "$name" in
      traefik|portainer) return 0 ;;
    esac

    if grep -qx "$name" "$deployed_list" 2>/dev/null; then
      return 0
    fi

    yaml=$(find_stack_yaml "$name" 2>/dev/null || true)
    if [ -z "$yaml" ]; then
      warn "Stack '$name' sem YAML no destino — não redeployada"
      echo "$name" >> "$failed_list"
      return 1
    fi

    deploy_i=$((deploy_i + 1))
    info "[$deploy_i] Deploy via Portainer API: $name ($yaml)"
    if [ "$name" = "supabase" ]; then
      fix_supabase_permissions_contingency
    fi
    if deploy_stack_via_portainer "$name" "$yaml"; then
      echo "$name" >> "$deployed_list"
      return 0
    fi

    echo "$name" >> "$failed_list"
    return 1
  }

  local priority=(postgres pgvector)
  local p
  for p in "${priority[@]}"; do
    grep -qx "$p" "$PORTAINER_DEPLOY_FILE" 2>/dev/null && deploy_one_stack "$p" || true
  done

  while IFS= read -r stack || [ -n "$stack" ]; do
    [ -z "$stack" ] && continue
    deploy_one_stack "$stack" || true
  done < <(sort -u "$PORTAINER_DEPLOY_FILE")

  local deployed failed
  deployed=$(wc -l < "$deployed_list" | tr -d ' ')
  failed=$(wc -l < "$failed_list" | tr -d ' ')
  local apps_done
  apps_done=$(grep -vxE 'traefik|portainer' "$deployed_list" 2>/dev/null | grep -c . || true)
  ok "Apps ativadas no Portainer: $apps_done/$stack_total" 
  if [ "$failed" -gt 0 ]; then
    warn "Stacks sem deploy ($failed):"
    while IFS= read -r s || [ -n "$s" ]; do
      [ -z "$s" ] && continue
      echo -e "  ${VERMELHO}- $s${RESET}"
    done < "$failed_list"
  fi
}

ensure_portainer_credentials() {
  grep -qx "portainer" "$STACKS_FILE" 2>/dev/null || return 0

  if [ -n "$PORTAINER_USER" ] && [ -n "$PORTAINER_PASS" ]; then
    ok "Credenciais Portainer: $PORTAINER_USER (dados_vps)"
    return 0
  fi

  step "Credenciais do Portainer"
  echo -e "${BRANCO}Não encontramos dados_portainer em /root/dados_vps.${RESET}"
  echo -e "${BRANCO}Com SetupOrion isso vem automático — em outras instalações você define aqui.${RESET}"
  echo ""

  local user="" pass="" pass2=""
  while [ -z "$user" ]; do
    read -r -p "$(echo -e "${AMARELO}Usuário admin do Portainer [admin]: ${RESET}")" user
    user="${user:-admin}"
  done

  while true; do
    read -r -s -p "$(echo -e "${AMARELO}Senha (mín. 12 caracteres): ${RESET}")" pass
    echo ""
    read -r -s -p "$(echo -e "${AMARELO}Confirme a senha: ${RESET}")" pass2
    echo ""
    if [ "$pass" != "$pass2" ]; then
      warn "Senhas não coincidem — tente de novo."
      continue
    fi
    if [ "${#pass}" -lt 12 ]; then
      warn "Portainer exige senha com pelo menos 12 caracteres."
      continue
    fi
    break
  done

  PORTAINER_USER="$user"
  PORTAINER_PASS="$pass"
  ok "Credenciais definidas para criar o admin no destino"
}

init_portainer_admin() {
  step "Recriando admin do Portainer no destino"
  if [ -z "$PORTAINER_USER" ] || [ -z "$PORTAINER_PASS" ]; then
    warn "Sem credenciais — crie o admin manualmente no Portainer novo."
    return 1
  fi

  portainer_dest_domain
  local domain="$PORTAINER_DEST_DOMAIN"
  local user_b64 pass_b64 out rc=0
  user_b64=$(printf '%s' "$PORTAINER_USER" | base64 -w0 2>/dev/null || printf '%s' "$PORTAINER_USER" | base64)
  pass_b64=$(printf '%s' "$PORTAINER_PASS" | base64 -w0 2>/dev/null || printf '%s' "$PORTAINER_PASS" | base64)

  out=$(remote_script "DOMAIN='$domain' USER_B64='$user_b64' PASS_B64='$pass_b64' bash -s" <<'REMOTE' 2>&1
set -euo pipefail
USER=$(echo "$USER_B64" | base64 -d)
PASS=$(echo "$PASS_B64" | base64 -d)
if command -v jq >/dev/null 2>&1; then
  PAYLOAD=$(jq -n --arg u "$USER" --arg p "$PASS" '{Username:$u,Password:$p}')
else
  PAYLOAD=$(printf '{"Username":"%s","Password":"%s"}' "$USER" "$PASS")
fi

for i in $(seq 1 15); do
  SETUP_TOKEN=$(docker service logs portainer_portainer 2>&1 | grep -oE 'setup_token=[a-f0-9]+' | tail -1 | cut -d= -f2 || true)
  for BASE in "https://127.0.0.1" "http://127.0.0.1:9000"; do
    URL="${BASE}/api/users/admin/init"
    if [ -n "$SETUP_TOKEN" ]; then
      RESP=$(curl -sk -X POST "$URL" -H "Host: $DOMAIN" -H "Content-Type: application/json" \
        -H "X-Setup-Token: $SETUP_TOKEN" -d "$PAYLOAD" 2>/dev/null || true)
    else
      RESP=$(curl -sk -X POST "$URL" -H "Host: $DOMAIN" -H "Content-Type: application/json" \
        -d "$PAYLOAD" 2>/dev/null || true)
    fi
    if echo "$RESP" | grep -q '"Username"'; then echo "OK:created"; exit 0; fi
    if echo "$RESP" | grep -qiE 'already|exists|initialized'; then echo "OK:exists"; exit 0; fi
  done
  sleep 6
done
echo "FAIL:timeout"
exit 1
REMOTE
) || rc=$?
  if echo "$out" | grep -q '^OK:'; then
    ok "Admin Portainer criado: $PORTAINER_USER (@$domain)"
    return 0
  fi

  warn "Não foi possível criar o admin automaticamente."
  [ -n "$out" ] && warn "Detalhe: $(echo "$out" | tail -3 | tr '\n' ' ')"
  warn "Verifique DNS → ${DEST_IP}, Traefik e: docker service logs portainer_portainer"
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
  local expected dest_stacks missing=0
  expected=0
  grep -qx "traefik" "$STACKS_FILE" 2>/dev/null && expected=$((expected + 1))
  grep -qx "portainer" "$STACKS_FILE" 2>/dev/null && expected=$((expected + 1))
  if [ -f "$PORTAINER_DEPLOY_FILE" ]; then
    expected=$((expected + $(wc -l < "$PORTAINER_DEPLOY_FILE" | tr -d ' ')))
  fi
  dest_stacks=$(remote "docker stack ls --format '{{.Name}}' | wc -l" 2>/dev/null | tr -d ' \r' || echo 0)
  if [ "$dest_stacks" -ge 1 ]; then
    ok "Destino tem $dest_stacks stack(s) (esperado ~$expected)"
  else
    off "Nenhuma stack no destino"
  fi

  echo ""
  echo -e "${BRANCO}Stacks esperadas no destino:${RESET}"
  missing=0
  while IFS= read -r stack || [ -n "$stack" ]; do
    [ -z "$stack" ] && continue
    if remote "docker stack ls --format '{{.Name}}' | grep -qx '$stack'"; then
      echo -e "  ${VERDE}✓${RESET} $stack"
    else
      echo -e "  ${VERMELHO}✗${RESET} $stack"
      missing=$((missing + 1))
    fi
  done < <(
    {
      grep -qx "traefik" "$STACKS_FILE" 2>/dev/null && echo "traefik"
      grep -qx "portainer" "$STACKS_FILE" 2>/dev/null && echo "portainer"
      [ -f "$PORTAINER_DEPLOY_FILE" ] && cat "$PORTAINER_DEPLOY_FILE"
    } | sort -u
  )

  if [ "$missing" -gt 0 ]; then
    warn "$missing stack(s) ausente(s) — revise o log"
  else
    ok "Todas as stacks esperadas estão no destino"
  fi
}

final_report() {
  step "Migração concluída"
  echo -e "${AMARELO}===================================================================================================${RESET}"
  echo -e "${VERDE}  IMPA Migrator v. ${IMPA_MIGRATOR_VERSION} — relatório final${RESET}"
  echo -e "${AMARELO}===================================================================================================${RESET}"
  echo ""
  echo -e "  Destino:     ${CIANO}${DEST_USER}@${DEST_IP}${RESET}"
  echo -e "  Dados:       ${CIANO}$TOTAL_HUMAN${RESET}"
  echo -e "  Modo:        ${CIANO}${ORIGIN_MODE}${RESET}"
  if [ -n "$PORTAINER_DEST_DOMAIN" ]; then
    if [ "$PORTAINER_TEMP_BOOTSTRAP" = "yes" ]; then
      echo -e "  Portainer:   ${CIANO}https://${PORTAINER_DEST_DOMAIN}${RESET} ${AMARELO}(temporário — bootstrap)${RESET}"
      echo -e "  Produção:    ${CIANO}https://${PORTAINER_ORIG_DOMAIN}${RESET} ${BRANCO}(aponte no cutover final)${RESET}"
    else
      echo -e "  Portainer:   ${CIANO}https://${PORTAINER_DEST_DOMAIN}${RESET}"
    fi
    echo -e "  Usuário:     ${CIANO}$PORTAINER_USER${RESET}"
  elif [ -n "$PORTAINER_URL" ]; then
    echo -e "  Portainer:   ${CIANO}https://${PORTAINER_URL#https://}${RESET}"
    echo -e "  Usuário:     ${CIANO}$PORTAINER_USER${RESET}"
  fi
  echo ""
  echo -e "  ${AMARELO}PRÓXIMOS PASSOS:${RESET}"
  if [ "$PORTAINER_TEMP_BOOTSTRAP" = "yes" ]; then
    echo -e "  1. Acesse o Portainer em ${VERDE}https://${PORTAINER_DEST_DOMAIN}${RESET} (domínio temporário)"
    echo -e "  2. Aponte os demais domínios das apps para ${VERDE}${DEST_IP}${RESET}"
    echo -e "  3. No cutover, troque ${PORTAINER_ORIG_DOMAIN} → ${DEST_IP} (ou mantenha o temp.)"
  else
    echo -e "  1. Apontar os registros DNS A dos seus domínios para ${VERDE}${DEST_IP}${RESET}"
    echo -e "  2. Aguardar propagação DNS e testar Traefik/Portainer/apps"
  fi
  if [ "$ORIGIN_MODE" = "test" ]; then
    echo -e "  • A origem está ${VERDE}LIGADA${RESET} de novo — pode voltar o DNS se precisar"
    echo -e "  • Só cancele a VPS antiga quando tiver certeza da nova"
  else
    echo -e "  • A origem está ${AMARELO}PAUSADA${RESET} (intacta). Só desligue/cancele quando validar a nova"
    echo -e "  • Rollback (religar origem):"
    echo -e "       ${CIANO}docker service scale NOME=1${RESET}"
    echo -e "       ${CIANO}# ou: docker stack deploy -c /root/STACK.yaml STACK${RESET}"
  fi
  echo ""
  echo -e "  Log completo: ${AMARELO}$LOG_FILE${RESET}"
  echo -e "  Créditos: ${CIANO}IMPA 365${RESET} — https://impa365.com"
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
  log "=== IMPA Migrator v.${IMPA_MIGRATOR_VERSION} start ==="

  banner
  accept_credits
  clear 2>/dev/null || true
  banner

  echo -e "${BRANCO}Migra ambientes Docker Swarm (Portainer/stacks/volumes) para uma VPS nova e limpa.${RESET}"
  echo -e "${BRANCO}SetupOrion recomendado (credenciais automáticas). Não clona o sistema operacional.${RESET}"
  echo ""
  if ! confirm_yn "Requisitos OK (Debian/Ubuntu, destino limpo, mesma arch)"; then
    die "Aceite necessário para continuar."
  fi

  backup_gate
  choose_origin_mode

  require_root
  validate_origin_os
  install_origin_deps
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
  transfer_root_preflight
  bootstrap_dest_infra
  freeze_origin
  transfer_all
  deploy_application_stacks
  validate_migration

  if [ "$ORIGIN_MODE" = "test" ]; then
    unfreeze_origin
  fi

  final_report

  log "=== IMPA Migrator v.${IMPA_MIGRATOR_VERSION} end ==="
}

main "$@"
