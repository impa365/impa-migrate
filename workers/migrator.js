/**
 * IMPA Migrator edge worker
 * - Browser  → landing (visual alinhado a impa365.com)
 * - curl/wget → impa-migrator.sh
 * - /install  → sempre o script
 */
// Commit fixo — evita CDN da edge servir main desatualizado por POP (ex.: GRU)
const SCRIPT_COMMIT = "cb094739cca2e36e762966a0500f65c6b2515432";
const SCRIPT_URL = `https://raw.githubusercontent.com/impa365/impa-migrate/${SCRIPT_COMMIT}/impa-migrator.sh`;

const VERSION = "1.1.33";
const INSTALL_CMD = "bash <(curl -sSL https://migrator.impa365.com)";

function wantsScript(request, pathname) {
  if (
    pathname === "/install" ||
    pathname === "/impa-migrator.sh" ||
    pathname.endsWith(".sh")
  ) {
    return true;
  }
  const ua = (request.headers.get("User-Agent") || "").toLowerCase();
  if (
    ua.includes("curl") ||
    ua.includes("wget") ||
    ua.includes("httpie") ||
    ua.includes("fetch")
  ) {
    return true;
  }
  const accept = (request.headers.get("Accept") || "").toLowerCase();
  if (accept.includes("text/html")) return false;
  if (!ua.includes("mozilla")) return true;
  return false;
}

const PAINEL_INSTALL_SH = "#!/usr/bin/env bash\n# IMPA Migrate \u2014 Painel Web de Migra\u00e7\u00e3o Docker Swarm & VPS (IMPA 365)\n# Uso: bash install.sh   ou   bash <(curl -sSL https://migrator.impa365.com/panel)\nset -euo pipefail\n\nMIGRATOR_VERSION=\"1.2.0\"\nMIGRATOR_PORT=\"${MIGRATOR_PORT:-8899}\"\nINSTALL_DIR=\"/opt/impamigrate\"\nDADOS_DIR=\"/root/dados_vps\"\nLOG_FILE=\"/var/log/impa-migrator.log\"\n\nRED='\\033[0;31m'\nGREEN='\\033[0;32m'\nYELLOW='\\033[1;33m'\nCYAN='\\033[0;36m'\nWHITE='\\033[1;37m'\nGRAY='\\033[0;90m'\nBOLD='\\033[1m'\nRESET='\\033[0m'\n\nlog() {\n  echo \"[$(date -Iseconds 2>/dev/null || date)] $*\" >> \"$LOG_FILE\" 2>/dev/null || true\n}\n\nok() {\n  echo -e \"    ${GREEN}\u2714${RESET} ${WHITE}$1${RESET}\"\n  log \"OK: $1\"\n}\n\nwarn() {\n  echo -e \"    ${YELLOW}\u26a0${RESET} ${YELLOW}$1${RESET}\"\n  log \"WARN: $1\"\n}\n\ndie() {\n  echo \"\"\n  echo -e \"  ${RED}\u2716 ERRO:${RESET} ${WHITE}$1${RESET}\"\n  echo -e \"  ${GRAY}Detalhes salvos em: $LOG_FILE${RESET}\"\n  echo \"\"\n  log \"FATAL: $1\"\n  exit 1\n}\n\ninfo() {\n  echo -e \"    ${CYAN}\u279c${RESET} ${GRAY}$1${RESET}\"\n  log \"INFO: $1\"\n}\n\nstep() {\n  echo \"\"\n  echo -e \"  ${CYAN}[$1]${RESET} ${BOLD}${WHITE}$2${RESET}\"\n  log \"STEP: $1 - $2\"\n}\n\nbanner() {\n  clear 2>/dev/null || true\n  echo \"\"\n  echo -e \"  ${CYAN}\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510${RESET}\"\n  echo -e \"  ${CYAN}\u2502${RESET}                                                              ${CYAN}\u2502${RESET}\"\n  echo -e \"  ${CYAN}\u2502${RESET}   ${BOLD}${WHITE}\ud83d\ude80 IMPA MIGRATE \u2014 PAINEL WEB${RESET}  ${CYAN}v${MIGRATOR_VERSION}${RESET}                          ${CYAN}\u2502${RESET}\"\n  echo -e \"  ${CYAN}\u2502${RESET}   ${GRAY}Migra\u00e7\u00e3o Completa de Docker Swarm, Stacks & Volumes${RESET}         ${CYAN}\u2502${RESET}\"\n  echo -e \"  ${CYAN}\u2502${RESET}   ${CYAN}https://migrator.impa365.com${RESET}  \u00b7  ${WHITE}IMPA 365${RESET}                       ${CYAN}\u2502${RESET}\"\n  echo -e \"  ${CYAN}\u2502${RESET}                                                              ${CYAN}\u2502${RESET}\"\n  echo -e \"  ${CYAN}\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518${RESET}\"\n}\n\nrequire_root() {\n  if [ \"$(id -u 2>/dev/null || echo 1)\" -ne 0 ]; then\n    die \"Voc\u00ea precisa executar este comando como root. Use: sudo bash <(curl -sSL https://migrator.impa365.com/panel)\"\n  fi\n}\n\ndetect_public_ip() {\n  local ip=\"\"\n  if [ -f \"$DADOS_DIR/public_ip\" ]; then\n    ip=\"$(cat \"$DADOS_DIR/public_ip\" 2>/dev/null | tr -d ' \\n\\r')\"\n  fi\n  if [ -z \"$ip\" ]; then\n    for provider in \"https://ifconfig.me/ip\" \"https://icanhazip.com\" \"https://api.ipify.org\"; do\n      ip=\"$(curl -fsS -m 4 \"$provider\" 2>/dev/null | tr -d ' \\n\\r' || true)\"\n      if [[ \"$ip\" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then\n        break\n      fi\n      ip=\"\"\n    done\n  fi\n  echo \"${ip:-127.0.0.1}\"\n}\n\nensure_docker() {\n  if ! command -v docker >/dev/null 2>&1; then\n    step \"1/4\" \"Instalando Docker...\"\n    curl -fsSL https://get.docker.com | sh\n    systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || true\n    ok \"Docker instalado com sucesso\"\n  else\n    ok \"Docker j\u00e1 est\u00e1 instalado\"\n  fi\n}\n\ngenerate_token() {\n  mkdir -p \"$DADOS_DIR\" \"$INSTALL_DIR\"\n  local token=\"\"\n  if [ -f \"$DADOS_DIR/migrator_auth.json\" ]; then\n    token=\"$(grep -o '\"token\": *\"[^\"]*\"' \"$DADOS_DIR/migrator_auth.json\" | cut -d'\"' -f4 || true)\"\n  fi\n  if [ -z \"$token\" ]; then\n    token=\"migrator_$(openssl rand -hex 24 2>/dev/null || tr -dc 'a-zA-Z0-9' < /dev/urandom | head -c 48)\"\n    cat <<EOF > \"$DADOS_DIR/migrator_auth.json\"\n{\n  \"token\": \"$token\",\n  \"created_at\": $(date +%s),\n  \"role\": \"admin\"\n}\nEOF\n    chmod 600 \"$DADOS_DIR/migrator_auth.json\"\n  fi\n  echo \"$token\"\n}\n\nis_port_in_use() {\n  local p=\"$1\"\n  if command -v ss >/dev/null 2>&1; then\n    if ss -tulpn 2>/dev/null | grep -qE \"[:.]${p}\\b\"; then\n      return 0\n    fi\n  fi\n  if command -v lsof >/dev/null 2>&1; then\n    if lsof -i \":${p}\" >/dev/null 2>&1; then\n      return 0\n    fi\n  fi\n  if command -v netstat >/dev/null 2>&1; then\n    if netstat -tulpn 2>/dev/null | grep -qE \"[:.]${p}\\b\"; then\n      return 0\n    fi\n  fi\n  if command -v docker >/dev/null 2>&1; then\n    if docker ps --format '{{.Ports}}' 2>/dev/null | grep -qE \"(:${p}->|0.0.0.0:${p}\\b)\"; then\n      return 0\n    fi\n  fi\n  return 1\n}\n\nfind_available_port() {\n  local target_port=\"${1:-8899}\"\n\n  if is_port_in_use \"$target_port\"; then\n    local occupant=\"\"\n    if command -v docker >/dev/null 2>&1; then\n      occupant=$(docker ps --filter \"publish=${target_port}\" --format 'Container {{.Names}} ({{.Image}})' 2>/dev/null | head -n1 || true)\n    fi\n    if [ -z \"$occupant\" ] && command -v ss >/dev/null 2>&1; then\n      occupant=$(ss -tulpn 2>/dev/null | grep -E \"[:.]${target_port}\\b\" | head -n1 || true)\n    fi\n\n    if [ -n \"$occupant\" ]; then\n      warn \"Porta ${target_port} j\u00e1 est\u00e1 em uso por: ${occupant}\"\n    else\n      warn \"Porta ${target_port} j\u00e1 est\u00e1 em uso por outro servi\u00e7o no host.\"\n    fi\n\n    local candidate=$((target_port + 1))\n    while is_port_in_use \"$candidate\"; do\n      candidate=$((candidate + 1))\n      if [ $candidate -gt 8950 ]; then\n        candidate=9099\n        break\n      fi\n    done\n    info \"Porta alternativa selecionada automaticamente: ${candidate}\"\n    echo \"$candidate\"\n  else\n    echo \"$target_port\"\n  fi\n}\n\ndeploy_container() {\n  step \"2/4\" \"Preparando diret\u00f3rios e arquivos...\"\n  mkdir -p \"$INSTALL_DIR\" \"$DADOS_DIR\"\n  local script_dir\n  script_dir=\"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")\" 2>/dev/null && pwd || echo \"\")\"\n\n  if [ -n \"$script_dir\" ] && [ -d \"$script_dir/agent\" ]; then\n    cp -r \"$script_dir/agent\" \"$INSTALL_DIR/\"\n    cp \"$script_dir/docker-compose.agent.yml\" \"$INSTALL_DIR/\" 2>/dev/null || true\n  elif [ ! -d \"$INSTALL_DIR/agent\" ]; then\n    info \"Baixando arquivos do painel IMPA Migrate...\"\n    if curl -fsSL -m 15 \"https://migrator.impa365.com/impamigrate.tar.gz\" -o \"/tmp/impamigrate.tar.gz\" 2>/dev/null; then\n      tar -xzf \"/tmp/impamigrate.tar.gz\" -C \"$INSTALL_DIR\" 2>/dev/null || true\n      rm -f \"/tmp/impamigrate.tar.gz\"\n    fi\n\n    if [ ! -d \"$INSTALL_DIR/agent\" ]; then\n      info \"Clonando reposit\u00f3rio oficial...\"\n      if ! command -v git >/dev/null 2>&1; then\n        apt-get update -qq && apt-get install -y -qq git >/dev/null 2>&1 || true\n      fi\n      git clone --depth 1 https://github.com/impa365/impa-migrate.git /tmp/impa-repo-dl 2>/dev/null || true\n      if [ -d \"/tmp/impa-repo-dl/impamigrate/agent\" ]; then\n        cp -r /tmp/impa-repo-dl/impamigrate/agent \"$INSTALL_DIR/\"\n        cp /tmp/impa-repo-dl/impamigrate/docker-compose.agent.yml \"$INSTALL_DIR/\" 2>/dev/null || true\n      fi\n      rm -rf /tmp/impa-repo-dl\n    fi\n  fi\n\n  if [ ! -d \"$INSTALL_DIR/agent\" ]; then\n    die \"N\u00e3o foi poss\u00edvel obter os arquivos do painel em $INSTALL_DIR/agent\"\n  fi\n\n  step \"3/4\" \"Subindo container do Painel de Migra\u00e7\u00e3o...\"\n  docker rm -f impamigrate-agent 2>/dev/null || true\n\n  local token=\"$1\"\n  local pub_ip=\"$2\"\n\n  MIGRATOR_PORT=\"$(find_available_port \"${MIGRATOR_PORT}\")\"\n\n  local max_retries=5\n  local started=0\n\n  for try in $(seq 1 $max_retries); do\n    docker rm -f impamigrate-agent 2>/dev/null || true\n\n    if docker run -d \\\n      --name impamigrate-agent \\\n      --restart unless-stopped \\\n      -p \"${MIGRATOR_PORT}:8899\" \\\n      -v /var/run/docker.sock:/var/run/docker.sock \\\n      -v /root:/root \\\n      -v /var/lib/docker/volumes:/var/lib/docker/volumes \\\n      -v \"$INSTALL_DIR:/opt/impamigrate\" \\\n      -v /var/log:/var/log \\\n      -e MIGRATOR_TOKEN=\"$token\" \\\n      -e MIGRATOR_PORT=\"$MIGRATOR_PORT\" \\\n      -e MIGRATOR_PUBLIC_IP=\"$pub_ip\" \\\n      -e IMPA_MIGRATOR_VERSION=\"$MIGRATOR_VERSION\" \\\n      python:3.12-slim bash -c \"apt-get update -qq && apt-get install -y -qq openssh-client sshpass pv curl >/dev/null 2>&1 && pip install -q fastapi 'uvicorn[standard]' pydantic httpx docker PyYAML jinja2 paramiko && cd /opt/impamigrate/agent && python -m uvicorn app:app --host 0.0.0.0 --port 8899\" >/dev/null 2>&1; then\n      started=1\n      break\n    else\n      warn \"Docker n\u00e3o conseguiu alocar a porta ${MIGRATOR_PORT}. Tentando porta $((MIGRATOR_PORT + 1))...\"\n      MIGRATOR_PORT=$((MIGRATOR_PORT + 1))\n    fi\n  done\n\n  if [ \"$started\" -ne 1 ]; then\n    die \"Falha ao iniciar container nas portas testadas. Verifique portas em uso com: ss -tulpn\"\n  fi\n\n  ok \"Container impamigrate-agent iniciado com sucesso na porta ${MIGRATOR_PORT}\"\n}\n\nwait_healthy() {\n  step \"4/4\" \"Verificando inicializa\u00e7\u00e3o da API...\"\n  info \"Aguardando depend\u00eancias e inicializa\u00e7\u00e3o do servidor...\"\n  local attempts=0\n  while [ $attempts -lt 40 ]; do\n    if curl -fsS -m 2 \"http://127.0.0.1:${MIGRATOR_PORT}/api/health\" >/dev/null 2>&1; then\n      ok \"Painel online e respondendo na porta ${MIGRATOR_PORT}\"\n      return 0\n    fi\n    sleep 2\n    attempts=$((attempts + 1))\n  done\n  die \"O painel demorou para inicializar. Verifique: docker logs impamigrate-agent\"\n}\n\nshow_completion() {\n  local token=\"$1\"\n  local pub_ip=\"$2\"\n  local panel_url=\"http://${pub_ip}:${MIGRATOR_PORT}/?token=${token}\"\n\n  echo \"\"\n  echo -e \"  ${GREEN}\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550${RESET}\"\n  echo -e \"  ${BOLD}${GREEN}\u2714 PAINEL IMPA MIGRATE INSTALADO COM SUCESSO!${RESET}\"\n  echo -e \"  ${GREEN}\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550${RESET}\"\n  echo \"\"\n  echo -e \"  ${BOLD}Acesse o painel pelo navegador:${RESET}\"\n  echo -e \"  ${CYAN}${BOLD}${panel_url}${RESET}\"\n  echo \"\"\n  echo -e \"  ${GRAY}Token administrativo:${RESET} ${WHITE}${token}${RESET}\"\n  echo -e \"  ${GRAY}Porta:${RESET} ${WHITE}${MIGRATOR_PORT}${RESET}\"\n  echo -e \"  ${GRAY}Logs:${RESET} ${WHITE}docker logs -f impamigrate-agent${RESET}\"\n  echo \"\"\n}\n\nmain() {\n  require_root\n  banner\n  local pub_ip\n  pub_ip=\"$(detect_public_ip)\"\n  ensure_docker\n  local token\n  token=\"$(generate_token)\"\n  deploy_container \"$token\" \"$pub_ip\"\n  wait_healthy\n  show_completion \"$token\" \"$pub_ip\"\n}\n\nmain \"$@\"\n";
const TARBALL_B64 = "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";

function servePainelScript() {
  return new Response(PAINEL_INSTALL_SH, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-IMPA-Migrator": "painel-script",
      "X-IMPA-Version": VERSION,
    },
  });
}

function serveTarball() {
  const binary = Uint8Array.from(atob(TARBALL_B64), (c) => c.charCodeAt(0));
  return new Response(binary, {
    status: 200,
    headers: {
      "Content-Type": "application/gzip",
      "Cache-Control": "no-store",
      "Content-Disposition": 'attachment; filename="impamigrate.tar.gz"',
    },
  });
}

async function serveScript() {
  const upstream = await fetch(SCRIPT_URL, {
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-IMPA-Migrator": "script",
      "X-IMPA-Version": VERSION,
      "X-IMPA-Script-Commit": SCRIPT_COMMIT.slice(0, 7),
    },
  });
}



const TELEMETRY_PATH = "/telemetry";
const PAINEL_PATH = "/painel";
const COOKIE_NAME = "impa_admin";
const WHATSAPP_ASSISTED =
  "https://wa.me/557398631289?text=" +
  encodeURIComponent("Quero contratar a migração assistida");
const HOSTEG_VPS_16GB =
  "https://painel.hosteg.com.br/?cmd=cart&action=add&id=31&cycle=a&promocode=impa65";
const HOSTEG_AFFILIATE = "https://painel.hosteg.com.br/?affid=2&affplan=1";

function emptyStats() {
  return {
    pageViews: 0,
    started: 0,
    confirmed: 0,
    completed: 0,
    failed: 0,
    uniqueIps: 0,
    byStep: {},
    byVersion: {},
    recent: [],
    servers: [],
    visitors: [],
    pageViewSeen: {},
    visitorDedupe: true,
  };
}

/** Dia civil em UTC-3 (America/Sao_Paulo), YYYY-MM-DD */
function saoPauloDay(ts) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ts));
  } catch {
    return String(ts || "").slice(0, 10);
  }
}

function prunePageViewSeen(stats, keepDays = 90) {
  const seen = stats.pageViewSeen || {};
  const keep = new Set();
  for (let i = 0; i < keepDays; i++) {
    keep.add(saoPauloDay(new Date(Date.now() - i * 86400000).toISOString()));
  }
  const next = {};
  for (const [k, v] of Object.entries(seen)) {
    if (keep.has(k.split("|")[0])) next[k] = v;
  }
  stats.pageViewSeen = next;
}

function formatLoc(row) {
  const parts = [row.city, row.region, row.country].filter(Boolean);
  return parts.length ? parts.join(", ") : "—";
}

function upsertSiteVisitor(stats, event) {
  const ip = event.ip;
  if (!ip || ip === "unknown") return;
  stats.visitors = stats.visitors || [];
  const idx = stats.visitors.findIndex((v) => v.ip === ip);
  const base = {
    ip,
    country: event.country || null,
    city: event.city || null,
    region: event.region || null,
    lastSeen: event.ts,
  };
  if (idx >= 0) {
    const prev = stats.visitors[idx];
    stats.visitors[idx] = {
      ...prev,
      ...base,
      country: base.country || prev.country,
      city: base.city || prev.city,
      region: base.region || prev.region,
      firstSeen: prev.firstSeen || event.ts,
      hits: (prev.hits || 1) + 1,
    };
    const [row] = stats.visitors.splice(idx, 1);
    stats.visitors.unshift(row);
  } else {
    stats.visitors.unshift({
      ...base,
      firstSeen: event.ts,
      hits: 1,
    });
  }
  stats.visitors = stats.visitors.slice(0, 300);
}

function applyEvent(stats, event) {
  // Migração one-shot: contador antigo era pageview bruto (F5 inflava)
  if (!stats.visitorDedupe) {
    stats.pageViews = 0;
    stats.pageViewSeen = {};
    stats.visitorDedupe = true;
    if (stats.byStep && stats.byStep.page_view) stats.byStep.page_view = 0;
  }

  const step = event.step || "unknown";

  if (step === "page_view") {
    const ip = event.ip || "unknown";
    if (!ip || ip === "unknown") return stats;
    upsertSiteVisitor(stats, event);
    const key = `${saoPauloDay(event.ts)}|${ip}`;
    stats.pageViewSeen = stats.pageViewSeen || {};
    if (stats.pageViewSeen[key]) return stats; // mesmo IP no mesmo dia — não soma visitante único
    stats.pageViewSeen[key] = 1;
    prunePageViewSeen(stats);
    stats.pageViews += 1;
    stats.byStep[step] = (stats.byStep[step] || 0) + 1;
    if (event.version) {
      stats.byVersion[event.version] = (stats.byVersion[event.version] || 0) + 1;
    }
    stats.recent.unshift(event);
    stats.recent = stats.recent.slice(0, 150);
    return stats;
  }

  stats.byStep[step] = (stats.byStep[step] || 0) + 1;
  if (event.version) {
    stats.byVersion[event.version] = (stats.byVersion[event.version] || 0) + 1;
  }
  if (step === "start") stats.started += 1;
  if (step === "migration_confirmed") stats.confirmed += 1;
  if (step === "completed") stats.completed += 1;
  if (step === "failed") stats.failed += 1;

  stats.recent.unshift(event);
  stats.recent = stats.recent.slice(0, 150);

  if (event.ip && event.ip !== "unknown") {
    const idx = stats.servers.findIndex((s) => s.ip === event.ip);
    const row = {
      ip: event.ip,
      country: event.country || null,
      city: event.city || null,
      region: event.region || null,
      firstSeen: idx >= 0 ? stats.servers[idx].firstSeen : event.ts,
      lastSeen: event.ts,
      lastStep: step,
      version: event.version,
      mode: event.mode,
      run: event.run || null,
    };
    if (idx >= 0) {
      const prev = stats.servers[idx];
      stats.servers[idx] = {
        ...prev,
        ...row,
        country: row.country || prev.country,
        city: row.city || prev.city,
        region: row.region || prev.region,
      };
    } else {
      stats.uniqueIps += 1;
      stats.servers.unshift(row);
    }
    stats.servers = stats.servers.slice(0, 250);
  }
  return stats;
}

function doStub(env) {
  if (!env?.TELEMETRY_DO) return null;
  return env.TELEMETRY_DO.get(env.TELEMETRY_DO.idFromName("global"));
}

async function loadStats(env) {
  const stub = doStub(env);
  if (!stub) return emptyStats();
  try {
    const res = await stub.fetch("https://telemetry/stats");
    if (!res.ok) return emptyStats();
    return { ...emptyStats(), ...(await res.json()) };
  } catch {
    return emptyStats();
  }
}

async function persistEvent(env, event) {
  const stub = doStub(env);
  if (!stub) return;
  await stub.fetch("https://telemetry/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
}

export class TelemetryStore {
  constructor(ctx) {
    this.ctx = ctx;
  }
  async fetch(request) {
    let stats = (await this.ctx.storage.get("stats")) || emptyStats();
    // Contador antigo era pageview bruto (F5 inflava) — migra uma vez
    if (stats.visitorDedupe !== true) {
      stats.pageViews = 0;
      stats.pageViewSeen = {};
      stats.visitorDedupe = true;
      if (stats.byStep) stats.byStep.page_view = 0;
      await this.ctx.storage.put("stats", stats);
    }
    if (request.method === "POST") {
      const event = await request.json();
      stats = applyEvent(stats, event);
      await this.ctx.storage.put("stats", stats);
      return new Response("ok");
    }
    return Response.json(stats);
  }
}

async function handleTelemetry(request, env) {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  let body = {};
  try {
    body = await request.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const step = String(body.step || "unknown").slice(0, 64);
  const version = String(body.version || VERSION).slice(0, 16);
  const mode = String(body.mode || "").slice(0, 16);
  const run = String(body.run || "").slice(0, 48);
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown";
  const cf = request.cf || {};
  const country = String(cf.country || request.headers.get("CF-IPCountry") || "")
    .slice(0, 8)
    .toUpperCase() || null;
  const city = String(cf.city || "").slice(0, 64) || null;
  const region = String(cf.region || cf.regionCode || "").slice(0, 64) || null;
  const event = {
    ts: new Date().toISOString(),
    ip,
    step,
    version,
    mode: mode || null,
    run: run || null,
    country: country || null,
    city: city || null,
    region: region || null,
  };
  console.log("[IMPA_TELEMETRY]", JSON.stringify(event));
  try {
    await persistEvent(env, event);
  } catch (e) {
    console.log("[IMPA_TELEMETRY] kv failed", e?.message || e);
  }
  const hook = env?.TELEMETRY_WEBHOOK || null;
  if (hook && step !== "page_view") {
    try {
      const loc = formatLoc(event);
      await fetch(hook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `**IMPA Migrator**\nIP: \`${ip}\`\nLocal: ${loc}\nEtapa: **${step}**\nVersão: ${version}${mode ? `\nModo: ${mode}` : ""}`,
        }),
      });
    } catch (e) {
      console.log("[IMPA_TELEMETRY] webhook failed", e?.message || e);
    }
  }
  return new Response(null, { status: 204 });
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function sessionToken(password) {
  return sha256hex("impa-painel-v1:" + password);
}

function parseCookies(request) {
  const raw = request.headers.get("Cookie") || "";
  const out = {};
  raw.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

async function isAuthed(request, env) {
  const secret = env?.ADMIN_PASSWORD;
  if (!secret) return false;
  const token = parseCookies(request)[COOKIE_NAME];
  if (!token) return false;
  const expected = await sessionToken(secret);
  return timingSafeEqual(token, expected);
}

function cookieHeader(token) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
}

function loginPage(error) {
  const html = `<!DOCTYPE html>
<html lang="pt-BR"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex,nofollow"/>
<title>Painel IMPA Migrator</title>
<style>
  :root { --bg:#09090f; --fg:#f5f5f7; --muted:#9aa0b5; --cyan:#00e5e5; --red:#ff6b6b; --border:hsla(263,50%,40%,.45); }
  *{box-sizing:border-box;margin:0;padding:0}
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:"Segoe UI",system-ui,sans-serif;color:var(--fg);background:radial-gradient(700px 400px at 20% 0%, rgba(124,58,237,.28), transparent 55%), #09090f;}
  form{width:min(380px,92vw);padding:1.6rem;border:1px solid var(--border);border-radius:14px;background:#101018}
  h1{font-size:1.15rem;margin-bottom:.35rem}
  p{color:var(--muted);font-size:.9rem;margin-bottom:1rem}
  label{display:block;font-size:.8rem;margin-bottom:.35rem;color:var(--muted)}
  input{width:100%;padding:.75rem .85rem;border-radius:8px;border:1px solid var(--border);background:#0b0b12;color:var(--fg);margin-bottom:1rem}
  button{width:100%;padding:.8rem;border:0;border-radius:8px;font-weight:700;cursor:pointer;color:#fff;background:linear-gradient(135deg,#7c3aed,#00b3b3)}
  .err{color:var(--red);font-size:.85rem;margin-bottom:.75rem}
</style></head>
<body>
  <form method="post" action="/painel">
    <h1>Painel de telemetria</h1>
    <p>Acesso restrito — IMPA Migrator</p>
    ${error ? `<div class="err">${error}</div>` : ""}
    <label for="password">Senha</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus/>
    <button type="submit">Entrar</button>
  </form>
</body></html>`;
  return new Response(html, {
    status: error ? 401 : 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtClock(iso, timeZone) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t)?.value || "";
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
}

function fmtTs(iso) {
  if (!iso) return "—";
  const utc = fmtClock(iso, "UTC");
  const br = fmtClock(iso, "America/Sao_Paulo");
  if (!utc) return esc(String(iso));
  return `<span class="ts"><b>${esc(br)}</b><small>${esc(utc)} UTC</small></span>`;
}

function dashboardPage(stats) {
  const servers = stats.servers || [];
  const visitors = stats.visitors || [];
  const recent = stats.recent || [];
  const funnelOrder = [
    "start",
    "inventory_done",
    "dest_connected",
    "migration_confirmed",
    "bootstrap_done",
    "volumes_done",
    "deploy_done",
    "completed",
    "failed",
  ];
  const maxStep = Math.max(1, ...funnelOrder.map((k) => stats.byStep[k] || 0));
  const funnelRows = funnelOrder
    .map((k) => {
      const n = stats.byStep[k] || 0;
      const pct = Math.round((n / maxStep) * 100);
      return `<div class="funnel-row"><span>${esc(k)}</span><div class="bar"><i style="width:${pct}%"></i></div><b>${n}</b></div>`;
    })
    .join("");
  const visitorRows = visitors
    .slice(0, 100)
    .map(
      (v) =>
        `<tr><td><code>${esc(v.ip)}</code></td><td>${esc(formatLoc(v))}</td><td>${esc(String(v.hits || 1))}</td><td>${fmtTs(v.firstSeen)}</td><td>${fmtTs(v.lastSeen)}</td></tr>`
    )
    .join("");
  const serverRows = servers
    .slice(0, 80)
    .map(
      (s) =>
        `<tr><td><code>${esc(s.ip)}</code></td><td>${esc(formatLoc(s))}</td><td>${esc(s.lastStep)}</td><td>${esc(s.mode || "—")}</td><td>${esc(s.version || "—")}</td><td>${fmtTs(s.lastSeen)}</td></tr>`
    )
    .join("");
  const eventRows = recent
    .slice(0, 80)
    .map(
      (e) =>
        `<tr><td>${fmtTs(e.ts)}</td><td><code>${esc(e.ip)}</code></td><td>${esc(formatLoc(e))}</td><td>${esc(e.step)}</td><td>${esc(e.mode || "—")}</td><td>${esc(e.version || "—")}</td></tr>`
    )
    .join("");

  const html = `<!DOCTYPE html>
<html lang="pt-BR"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex,nofollow"/>
<title>Painel IMPA Migrator</title>
<style>
  :root { --bg:#09090f; --elev:#12121a; --fg:#f5f5f7; --muted:#9aa0b5; --cyan:#00e5e5; --violet:#7c3aed; --border:hsla(263,50%,40%,.4); }
  *{box-sizing:border-box;margin:0;padding:0}
  body{min-height:100vh;font-family:"Segoe UI",system-ui,sans-serif;color:var(--fg);background:radial-gradient(900px 500px at 10% -10%, rgba(124,58,237,.25), transparent 50%), var(--bg);}
  .wrap{width:min(1120px,calc(100% - 2rem));margin:0 auto;padding:1.4rem 0 3rem}
  header{display:flex;justify-content:space-between;align-items:center;gap:1rem;margin-bottom:1.5rem;flex-wrap:wrap}
  h1{font-size:1.25rem}
  header p{color:var(--muted);font-size:.9rem}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:1.5rem}
  .card{background:var(--elev);border:1px solid var(--border);border-radius:12px;padding:1rem 1.1rem}
  .card b{display:block;font-size:1.6rem;color:var(--cyan);margin-top:.2rem}
  .card span{color:var(--muted);font-size:.8rem}
  h2{font-size:1rem;margin:1.4rem 0 .7rem}
  .funnel-row{display:grid;grid-template-columns:180px 1fr 48px;gap:.6rem;align-items:center;margin-bottom:.45rem;font-size:.85rem}
  .bar{height:10px;background:#1c1c28;border-radius:99px;overflow:hidden}
  .bar i{display:block;height:100%;background:linear-gradient(90deg,var(--violet),var(--cyan))}
  table{width:100%;border-collapse:collapse;font-size:.85rem}
  th,td{text-align:left;padding:.55rem .4rem;border-bottom:1px solid var(--border)}
  th{color:var(--muted);font-weight:600}
  th .tz{display:block;font-size:.68rem;font-weight:500;opacity:.8;margin-top:.15rem}
  .ts{display:flex;flex-direction:column;gap:2px;font-variant-numeric:tabular-nums;white-space:nowrap}
  .ts b{font-weight:600;color:var(--fg)}
  .ts small{color:var(--muted);font-size:.72rem}
  code{font-family:ui-monospace,Consolas,monospace;color:var(--cyan)}
  .box{background:var(--elev);border:1px solid var(--border);border-radius:12px;padding:1rem;overflow:auto}
  @media (max-width:800px){ .cards{grid-template-columns:1fr 1fr} .funnel-row{grid-template-columns:1fr} }
</style></head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>IMPA Migrator · telemetria</h1>
        <p>Quem visita o site, quem roda o script e até onde chegou. Sem senhas ou dados de volume.</p>
      </div>
      <p>Atualiza ao recarregar</p>
    </header>
    <div class="cards">
      <div class="card"><span>Visitantes únicos (IP/dia)</span><b>${stats.pageViews || 0}</b></div>
      <div class="card"><span>Servidores únicos (IP)</span><b>${stats.uniqueIps || 0}</b></div>
      <div class="card"><span>Migrações iniciadas</span><b>${stats.started || 0}</b></div>
      <div class="card"><span>Confirmadas (MIGRAR)</span><b>${stats.confirmed || 0}</b></div>
      <div class="card"><span>Concluídas</span><b>${stats.completed || 0}</b></div>
      <div class="card"><span>Falhas / abortadas</span><b>${stats.failed || 0}</b></div>
    </div>
    <h2>Visitantes do site</h2>
    <div class="box">
      <table>
        <thead><tr><th>IP</th><th>Localização</th><th>Hits</th><th>Primeiro acesso<br/><span class="tz">UTC-3 · UTC</span></th><th>Último acesso<br/><span class="tz">UTC-3 · UTC</span></th></tr></thead>
        <tbody>${visitorRows || '<tr><td colspan="5">Nenhum visitante ainda — abra a landing uma vez.</td></tr>'}</tbody>
      </table>
    </div>
    <h2>Funil de etapas</h2>
    <div class="box">${funnelRows || "<p>Ainda sem eventos de migração.</p>"}</div>
    <h2>Servidores alcançados</h2>
    <div class="box">
      <table>
        <thead><tr><th>IP</th><th>Local</th><th>Última etapa</th><th>Modo</th><th>Versão</th><th>Último ping<br/><span class="tz">UTC-3 · UTC</span></th></tr></thead>
        <tbody>${serverRows || '<tr><td colspan="6">Nenhum servidor ainda.</td></tr>'}</tbody>
      </table>
    </div>
    <h2>Eventos recentes</h2>
    <div class="box">
      <table>
        <thead><tr><th>Quando<br/><span class="tz">UTC-3 · UTC</span></th><th>IP</th><th>Local</th><th>Etapa</th><th>Modo</th><th>Versão</th></tr></thead>
        <tbody>${eventRows || '<tr><td colspan="6">Nenhum evento ainda.</td></tr>'}</tbody>
      </table>
    </div>
  </div>
</body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}

async function handlePainel(request, env) {
  if (!env?.ADMIN_PASSWORD) {
    return new Response("Painel ainda sem senha. Rode o deploy-worker.ps1.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  if (request.method === "POST") {
    const form = await request.formData();
    const password = String(form.get("password") || "");
    const a = await sha256hex(password);
    const b = await sha256hex(env.ADMIN_PASSWORD);
    if (!timingSafeEqual(a, b)) return loginPage("Senha incorreta.");
    const token = await sessionToken(env.ADMIN_PASSWORD);
    const stats = await loadStats(env);
    const page = dashboardPage(stats);
    const headers = new Headers(page.headers);
    headers.set("Set-Cookie", cookieHeader(token));
    return new Response(page.body, { status: 200, headers });
  }
  if (!(await isAuthed(request, env))) return loginPage("");
  const stats = await loadStats(env);
  return dashboardPage(stats);
}

function landingPage() {
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>IMPA Migrator v${VERSION} — Migre sua VPS Docker</title>
  <meta name="description" content="Migre Docker Swarm, Portainer, stacks e volumes entre VPS com um comando. Feito pela IMPA 365." />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: hsl(240 10% 4%);
      --bg-elev: hsl(240 10% 6%);
      --fg: hsl(0 0% 98%);
      --muted: hsl(240 5% 64%);
      --primary: hsl(263 70% 50%);
      --primary-glow: hsla(263, 70%, 50%, 0.35);
      --cyan: hsl(180 100% 50%);
      --cyan-dim: hsla(180, 100%, 50%, 0.15);
      --border: hsla(263, 50%, 30%, 0.55);
      --radius: 0.75rem;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      min-height: 100vh;
      font-family: "Space Grotesk", system-ui, sans-serif;
      color: var(--fg);
      background:
        radial-gradient(900px 520px at 15% -5%, var(--primary-glow), transparent 55%),
        radial-gradient(700px 420px at 90% 0%, var(--cyan-dim), transparent 50%),
        var(--bg);
      line-height: 1.55;
    }
    a { color: var(--cyan); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .wrap { width: min(1100px, calc(100% - 2rem)); margin: 0 auto; }

    /* Nav */
    .nav {
      display: flex; align-items: center; justify-content: space-between;
      padding: 1.25rem 0;
    }
    .logo {
      font-family: Orbitron, sans-serif;
      font-weight: 700; font-size: 1rem; letter-spacing: 0.06em;
      color: var(--fg); text-decoration: none;
    }
    .logo span { color: var(--cyan); }
    .nav-links { display: flex; gap: 1.25rem; align-items: center; font-size: 0.9rem; color: var(--muted); }
    .nav-links a { color: var(--muted); text-decoration: none; }
    .nav-links a:hover { color: var(--fg); }
    .pill {
      font-size: 0.75rem; font-weight: 600; letter-spacing: 0.04em;
      border: 1px solid var(--border); border-radius: 999px;
      padding: 0.35rem 0.7rem; color: var(--cyan);
      background: hsla(263, 70%, 50%, 0.12);
    }

    /* Hero — composição única estilo Orion + IMPA */
    .hero {
      padding: 3.5rem 0 4rem;
      text-align: center;
      display: flex; flex-direction: column; align-items: center; gap: 1.1rem;
    }
    .eyebrow {
      font-family: Orbitron, sans-serif;
      font-size: 0.72rem; font-weight: 600; letter-spacing: 0.18em;
      text-transform: uppercase; color: var(--cyan);
    }
    .hero h1 {
      font-family: Orbitron, sans-serif;
      font-weight: 700;
      font-size: clamp(1.85rem, 5.2vw, 3.15rem);
      line-height: 1.15;
      letter-spacing: 0.02em;
      max-width: 18ch;
    }
    .hero h1 em {
      font-style: normal;
      background: linear-gradient(90deg, var(--cyan), #b57bff, var(--primary));
      -webkit-background-clip: text; background-clip: text;
      color: transparent;
    }
    .lead {
      max-width: 36rem;
      color: var(--muted);
      font-size: clamp(1rem, 2vw, 1.15rem);
    }

    /* Terminal / copy — peça central tipo Orion */
    .terminal {
      width: min(640px, 100%);
      margin-top: 0.75rem;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg-elev);
      box-shadow: 0 0 0 1px hsla(263,70%,50%,0.08), 0 24px 80px -30px var(--primary-glow);
      overflow: hidden;
      text-align: left;
    }
    .terminal-bar {
      display: flex; align-items: center; gap: 0.4rem;
      padding: 0.65rem 0.9rem;
      border-bottom: 1px solid var(--border);
      background: hsl(240 10% 5%);
    }
    .dot { width: 9px; height: 9px; border-radius: 50%; }
    .dot.r { background: #ff5f57; }
    .dot.y { background: #febc2e; }
    .dot.g { background: #28c840; }
    .terminal-title {
      margin-left: 0.5rem; font-size: 0.75rem; color: var(--muted);
      font-family: Orbitron, sans-serif; letter-spacing: 0.06em;
    }
    .terminal-body {
      display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center;
      padding: 1rem 1rem 1.1rem;
    }
    .terminal-body code {
      flex: 1 1 220px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.88rem;
      color: var(--cyan);
      word-break: break-all;
    }
    .btn-copy {
      border: 0; cursor: pointer;
      font-family: "Space Grotesk", sans-serif;
      font-weight: 700; font-size: 0.9rem;
      padding: 0.7rem 1.15rem;
      border-radius: calc(var(--radius) - 2px);
      color: #fff;
      background: linear-gradient(135deg, var(--primary), #7c3aed);
      box-shadow: 0 0 24px var(--primary-glow);
      transition: transform 0.15s ease, filter 0.15s ease;
    }
    .btn-copy:hover { transform: translateY(-1px); filter: brightness(1.08); }
    .btn-copy.ok {
      background: linear-gradient(135deg, hsl(180 80% 35%), hsl(180 100% 40%));
    }

    .req {
      margin-top: 0.35rem;
      font-size: 0.88rem; color: var(--muted);
      max-width: 34rem;
    }
    .req strong { color: var(--fg); font-weight: 600; }

    /* Stats strip — leve, não card-heavy */
    .stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1px;
      margin: 0.5rem 0 0;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      background: var(--border);
      max-width: 720px;
      width: 100%;
    }
    .stat {
      background: var(--bg-elev);
      padding: 1.15rem 1rem;
      text-align: center;
    }
    .stat b {
      display: block;
      font-family: Orbitron, sans-serif;
      font-size: 1.35rem;
      color: var(--cyan);
      margin-bottom: 0.2rem;
    }
    .stat span { font-size: 0.82rem; color: var(--muted); }

    /* Steps */
    .section {
      padding: 3.75rem 0 4rem;
      border-top: 1px solid var(--border);
    }
    .section-head {
      text-align: center;
      margin-bottom: 2rem;
    }
    .section-head h2 {
      font-family: Orbitron, sans-serif;
      font-size: clamp(1.35rem, 3vw, 1.85rem);
      letter-spacing: 0.04em;
      margin-bottom: 0.5rem;
    }
    .section-head p { color: var(--muted); max-width: 32rem; margin: 0 auto; }

    .steps {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1.25rem;
    }
    .step {
      padding: 1.5rem 1.25rem 1.6rem;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: linear-gradient(180deg, hsla(263,70%,50%,0.08), transparent 55%), var(--bg-elev);
    }
    .step .n {
      font-family: Orbitron, sans-serif;
      font-size: 0.75rem; letter-spacing: 0.12em;
      color: var(--cyan); margin-bottom: 0.75rem;
    }
    .step h3 {
      font-size: 1.05rem; font-weight: 600;
      margin-bottom: 0.45rem;
    }
    .step p { color: var(--muted); font-size: 0.92rem; }

    /* FAQ simples */
    .faq { max-width: 720px; margin: 0 auto; }
    details {
      border-bottom: 1px solid var(--border);
      padding: 1rem 0;
    }
    details summary {
      cursor: pointer; list-style: none;
      font-weight: 600; font-size: 1rem;
      display: flex; justify-content: space-between; gap: 1rem;
    }
    details summary::-webkit-details-marker { display: none; }
    details summary::after { content: "+"; color: var(--cyan); font-weight: 700; }
    details[open] summary::after { content: "–"; }
    details p {
      margin-top: 0.65rem; color: var(--muted); font-size: 0.95rem;
    }

    footer {
      border-top: 1px solid var(--border);
      padding: 1.75rem 0 2.5rem;
      display: flex; flex-wrap: wrap; gap: 0.75rem 1.5rem;
      justify-content: space-between;
      color: var(--muted); font-size: 0.88rem;
    }
    footer .brand-f {
      font-family: Orbitron, sans-serif; letter-spacing: 0.06em; color: var(--fg);
    }


    /* Promo + assisted migration */
    .promo-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 1.25rem;
      margin: 2rem 0 0;
      width: 100%;
      max-width: 900px;
    }
    .promo-card {
      position: relative;
      overflow: hidden;
      border-radius: var(--radius);
      border: 1px solid var(--border);
      padding: 1.35rem 1.25rem 1.4rem;
      background: linear-gradient(145deg, hsla(263,70%,50%,0.14), hsla(180,100%,50%,0.06)), var(--bg-elev);
      text-align: left;
    }
    .promo-card.hosteg {
      border-color: hsla(180, 100%, 50%, 0.35);
      background: linear-gradient(135deg, hsla(180,100%,50%,0.12), hsla(263,70%,50%,0.1)), var(--bg-elev);
    }
    .promo-card.assisted {
      border-color: hsla(142, 70%, 45%, 0.4);
      background: linear-gradient(135deg, hsla(142,70%,45%,0.12), hsla(263,70%,50%,0.08)), var(--bg-elev);
    }
    .promo-badge {
      display: inline-block;
      font-family: Orbitron, sans-serif;
      font-size: 0.68rem;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--cyan);
      border: 1px solid hsla(180,100%,50%,0.35);
      border-radius: 999px;
      padding: 0.28rem 0.65rem;
      margin-bottom: 0.75rem;
    }
    .promo-card.assisted .promo-badge {
      color: hsl(142, 70%, 55%);
      border-color: hsla(142,70%,45%,0.45);
    }
    .promo-card h3 {
      font-family: Orbitron, sans-serif;
      font-size: 1.05rem;
      letter-spacing: 0.03em;
      margin-bottom: 0.5rem;
    }
    .promo-card p {
      color: var(--muted);
      font-size: 0.92rem;
      margin-bottom: 1rem;
      line-height: 1.5;
    }
    .promo-price {
      font-family: Orbitron, sans-serif;
      font-size: 1.5rem;
      color: var(--cyan);
      margin: 0.25rem 0 0.75rem;
    }
    .promo-price small {
      font-size: 0.75rem;
      color: var(--muted);
      font-family: "Space Grotesk", sans-serif;
    }
    .btn-promo {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.4rem;
      border: 0;
      cursor: pointer;
      text-decoration: none;
      font-family: "Space Grotesk", sans-serif;
      font-weight: 700;
      font-size: 0.9rem;
      padding: 0.72rem 1.1rem;
      border-radius: calc(var(--radius) - 2px);
      color: #fff;
      transition: transform 0.15s ease, filter 0.15s ease;
    }
    .btn-promo:hover { transform: translateY(-1px); filter: brightness(1.08); text-decoration: none; }
    .btn-promo.wa {
      background: linear-gradient(135deg, hsl(142, 65%, 38%), hsl(142, 70%, 45%));
      box-shadow: 0 0 24px hsla(142,70%,45%,0.25);
    }
    .btn-promo.hosteg {
      background: linear-gradient(135deg, hsl(180, 80%, 35%), hsl(263, 70%, 50%));
      box-shadow: 0 0 24px var(--primary-glow);
    }
    .btn-promo.ghost {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg);
      margin-top: 0.5rem;
      font-weight: 600;
    }
    .promo-note {
      margin-top: 2.5rem;
      font-size: 0.8rem;
      color: var(--muted);
      max-width: 36rem;
    }

    @media (max-width: 800px) {
      .promo-grid { grid-template-columns: 1fr; }
      .steps, .stats { grid-template-columns: 1fr; }
      .nav-links .hide-sm { display: none; }
      .hero { padding-top: 2.25rem; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <nav class="nav">
      <a class="logo" href="https://impa365.com">IMPA <span>365</span></a>
      <div class="nav-links">
        <a class="hide-sm" href="https://impa365.com">Site</a>
        <a class="hide-sm" href="https://github.com/impa365/impa-migrate">GitHub</a>
        <span class="pill">MIGRATÖR v${VERSION}</span>
      </div>
    </nav>

    <header class="hero">
      <p class="eyebrow">Powered by IMPA 365</p>
      <h1>Migre sua VPS Docker em <em>segundos</em></h1>
      <p class="lead">
        Um comando na VPS antiga. Swarm, Portainer, stacks e volumes na VPS nova —
        sem reinstalar tudo na mão.
      </p>

      <div class="terminal" aria-label="Comando de instalação">
        <div class="terminal-bar">
          <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
          <span class="terminal-title">SSH · root@origem</span>
        </div>
        <div class="terminal-body">
          <code id="install-cmd">${INSTALL_CMD}</code>
          <button type="button" class="btn-copy" id="copy-btn">Copiar código</button>
        </div>
      </div>

      <p class="req">
        <strong>Obs:</strong> origem com Docker Swarm · destino Debian/Ubuntu <strong>limpo</strong> · mesma arch.
        Backup da VPS altamente recomendado.
      </p>


      <div class="promo-grid">
        <article class="promo-card assisted">
          <span class="promo-badge">Migração assistida</span>
          <h3>Precisa de um especialista?</h3>
          <p>Nossa equipe executa a migração completa na sua VPS — Docker Swarm, Portainer, stacks e volumes — com acompanhamento e validação.</p>
          <a class="btn-promo wa" href="${WHATSAPP_ASSISTED}" target="_blank" rel="noopener">Contratar agora → WhatsApp</a>
        </article>
        <article class="promo-card hosteg">
          <span class="promo-badge">Oferta Hosteg</span>
          <h3>VPS 16GB · 12 meses</h3>
          <p class="promo-price">R$ 899 <small>/ano com cupom IMPA65</small></p>
          <p>Ideal para rodar Swarm + Portainer + suas stacks com folga de RAM após a migração.</p>
          <a class="btn-promo hosteg" href="${HOSTEG_VPS_16GB}" target="_blank" rel="noopener">Contratar VPS com desconto</a>
          <a class="btn-promo ghost" href="${HOSTEG_AFFILIATE}" target="_blank" rel="noopener">Ver outros planos Hosteg</a>
        </article>
      </div>
      <p class="promo-note">Parceria Hosteg · cupom <strong>impa65</strong> no checkout. Migração assistida via IMPA 365.</p>

      <div class="stats" aria-label="Destaques">
        <div class="stat"><b>1 cmd</b><span>One-liner no SSH</span></div>
        <div class="stat"><b>Swarm</b><span>Stacks + volumes</span></div>
        <div class="stat"><b>Teste</b><span>Origem pode continuar viva</span></div>
      </div>
    </header>

    <section class="section" id="como">
      <div class="section-head">
        <h2>Veja como é simples</h2>
        <p>Três passos. Sem painel. Sem mistério.</p>
      </div>
      <div class="steps">
        <article class="step">
          <div class="n">PASSO 01</div>
          <h3>Copie o código</h3>
          <p>Cole no terminal SSH da VPS de origem (root). O wizard sobe sozinho.</p>
        </article>
        <article class="step">
          <div class="n">PASSO 02</div>
          <h3>Informe a VPS nova</h3>
          <p>IP, SSH, modo teste ou cutover. Confirme o backup e digite MIGRAR.</p>
        </article>
        <article class="step">
          <div class="n">PASSO 03</div>
          <h3>Aponte o DNS</h3>
          <p>Valide a nova VPS e mude os A records. A origem não é apagada.</p>
        </article>
      </div>
    </section>

    <section class="section" id="faq">
      <div class="section-head">
        <h2>Dúvidas frequentes</h2>
        <p>O essencial antes de rodar.</p>
      </div>
      <div class="faq">
        <details>
          <summary>Precisa ter instalado com SetupOrion?</summary>
          <p>Não é obrigatório, mas <strong>recomendamos muito</strong> o SetupOrion: ele guarda usuário, senha e domínio do Portainer em <code>/root/dados_vps</code>, e o migrador recria o mesmo login na VPS nova automaticamente.</p>
          <p>Em outras instalações essas informações nem sempre existem — nesse caso o migrador pede que você defina usuário e senha do admin do Portainer antes de subir as stacks.</p>
        </details>
        <details>
          <summary>A VPS de destino pode ter Docker?</summary>
          <p>Não. Tem que ser limpa (Debian/Ubuntu novo). Se já tiver Docker, o migrador aborta de propósito.</p>
        </details>
        <details>
          <summary>Bancos (Postgres, Chatwoot…) vêm junto?</summary>
          <p>Sim. Volumes nomeados são copiados (incluindo dados de banco). A origem é pausada na cópia para consistência.</p>
        </details>
        <details>
          <summary>Posso testar sem “matar” a VPS antiga?</summary>
          <p>Sim. No modo teste a origem é religada depois da transferência. Você aponta o DNS e pode voltar se precisar.</p>
        </details>
      </div>
    </section>

    <footer>
      <div><span class="brand-f">IMPA 365</span> · créditos ao usar o Migrator<br><span style="opacity:.75">Telemetria anônima de uso (etapa + versão) — sem senhas nem dados sensíveis.</span></div>
      <div>
        <a href="https://impa365.com">impa365.com</a>
        ·
        <a href="https://github.com/impa365/impa-migrate">GitHub</a>
        ·
        <a href="/install">/install</a>
      </div>
    </footer>
  </div>
  <script>
    const cmd = document.getElementById("install-cmd").textContent.trim();
    const btn = document.getElementById("copy-btn");
    fetch("/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: "page_view", version: "${VERSION}" }),
    }).catch(() => {});

    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(cmd);
        btn.textContent = "Copiado!";
        btn.classList.add("ok");
        setTimeout(() => {
          btn.textContent = "Copiar código";
          btn.classList.remove("ok");
        }, 1800);
      } catch (e) {
        btn.textContent = "Selecione e copie";
      }
    });
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      "X-IMPA-Migrator": "landing",
      "X-IMPA-Version": VERSION,
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "Content-Type": "text/plain" } });
    }
    if (url.pathname === "/impamigrate.tar.gz") {
      return serveTarball();
    }
    if (url.pathname === TELEMETRY_PATH) {
      return handleTelemetry(request, env);
    }
    if (
      url.pathname === "/panel" ||
      url.pathname === "/panel/" ||
      url.pathname === "/web" ||
      url.pathname === "/web/" ||
      url.pathname === "/web-install" ||
      url.pathname === "/panel-install" ||
      url.pathname === "/panel.sh"
    ) {
      return servePainelScript();
    }

    if (
      url.pathname === PAINEL_PATH ||
      url.pathname === PAINEL_PATH + "/" ||
      url.pathname === "/painel-install" ||
      url.pathname === "/painel.sh"
    ) {
      if (wantsScript(request, url.pathname)) {
        return servePainelScript();
      }
      return handlePainel(request, env);
    }
    if (wantsScript(request, url.pathname)) {
      return serveScript();
    }
    return landingPage();
  },
};
