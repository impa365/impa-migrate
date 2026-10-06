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

const PAINEL_INSTALL_SH = "#!/usr/bin/env bash\n# IMPA Migrate \u2014 Painel Web de Migra\u00e7\u00e3o Docker Swarm & VPS (IMPA 365)\n# Uso: bash install.sh   ou   bash <(curl -sSL https://migrator.impa365.com/panel)\nset -euo pipefail\n\nMIGRATOR_VERSION=\"1.2.0\"\nMIGRATOR_PORT=\"${MIGRATOR_PORT:-8899}\"\nINSTALL_DIR=\"/opt/impamigrate\"\nDADOS_DIR=\"/root/dados_vps\"\nLOG_FILE=\"/var/log/impa-migrator.log\"\n\nRED='\\033[0;31m'\nGREEN='\\033[0;32m'\nYELLOW='\\033[1;33m'\nCYAN='\\033[0;36m'\nWHITE='\\033[1;37m'\nGRAY='\\033[0;90m'\nBOLD='\\033[1m'\nRESET='\\033[0m'\n\nlog() {\n  echo \"[$(date -Iseconds 2>/dev/null || date)] $*\" >> \"$LOG_FILE\" 2>/dev/null || true\n}\n\nok() {\n  echo -e \"    ${GREEN}\u2714${RESET} ${WHITE}$1${RESET}\"\n  log \"OK: $1\"\n}\n\ndie() {\n  echo \"\"\n  echo -e \"  ${RED}\u2716 ERRO:${RESET} ${WHITE}$1${RESET}\"\n  echo -e \"  ${GRAY}Detalhes salvos em: $LOG_FILE${RESET}\"\n  echo \"\"\n  log \"FATAL: $1\"\n  exit 1\n}\n\ninfo() {\n  echo -e \"    ${CYAN}\u279c${RESET} ${GRAY}$1${RESET}\"\n  log \"INFO: $1\"\n}\n\nstep() {\n  echo \"\"\n  echo -e \"  ${CYAN}[$1]${RESET} ${BOLD}${WHITE}$2${RESET}\"\n  log \"STEP: $1 - $2\"\n}\n\nbanner() {\n  clear 2>/dev/null || true\n  echo \"\"\n  echo -e \"  ${CYAN}\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510${RESET}\"\n  echo -e \"  ${CYAN}\u2502${RESET}                                                              ${CYAN}\u2502${RESET}\"\n  echo -e \"  ${CYAN}\u2502${RESET}   ${BOLD}${WHITE}\ud83d\ude80 IMPA MIGRATE \u2014 PAINEL WEB${RESET}  ${CYAN}v${MIGRATOR_VERSION}${RESET}                          ${CYAN}\u2502${RESET}\"\n  echo -e \"  ${CYAN}\u2502${RESET}   ${GRAY}Migra\u00e7\u00e3o Completa de Docker Swarm, Stacks & Volumes${RESET}         ${CYAN}\u2502${RESET}\"\n  echo -e \"  ${CYAN}\u2502${RESET}   ${CYAN}https://migrator.impa365.com${RESET}  \u00b7  ${WHITE}IMPA 365${RESET}                       ${CYAN}\u2502${RESET}\"\n  echo -e \"  ${CYAN}\u2502${RESET}                                                              ${CYAN}\u2502${RESET}\"\n  echo -e \"  ${CYAN}\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518${RESET}\"\n}\n\nrequire_root() {\n  if [ \"$(id -u 2>/dev/null || echo 1)\" -ne 0 ]; then\n    die \"Voc\u00ea precisa executar este comando como root. Use: sudo bash <(curl -sSL https://migrator.impa365.com/panel)\"\n  fi\n}\n\ndetect_public_ip() {\n  local ip=\"\"\n  if [ -f \"$DADOS_DIR/public_ip\" ]; then\n    ip=\"$(cat \"$DADOS_DIR/public_ip\" 2>/dev/null | tr -d ' \\n\\r')\"\n  fi\n  if [ -z \"$ip\" ]; then\n    for provider in \"https://ifconfig.me/ip\" \"https://icanhazip.com\" \"https://api.ipify.org\"; do\n      ip=\"$(curl -fsS -m 4 \"$provider\" 2>/dev/null | tr -d ' \\n\\r' || true)\"\n      if [[ \"$ip\" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then\n        break\n      fi\n      ip=\"\"\n    done\n  fi\n  echo \"${ip:-127.0.0.1}\"\n}\n\nensure_docker() {\n  if ! command -v docker >/dev/null 2>&1; then\n    step \"1/4\" \"Instalando Docker...\"\n    curl -fsSL https://get.docker.com | sh\n    systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || true\n    ok \"Docker instalado com sucesso\"\n  else\n    ok \"Docker j\u00e1 est\u00e1 instalado\"\n  fi\n}\n\ngenerate_token() {\n  mkdir -p \"$DADOS_DIR\" \"$INSTALL_DIR\"\n  local token=\"\"\n  if [ -f \"$DADOS_DIR/migrator_auth.json\" ]; then\n    token=\"$(grep -o '\"token\": *\"[^\"]*\"' \"$DADOS_DIR/migrator_auth.json\" | cut -d'\"' -f4 || true)\"\n  fi\n  if [ -z \"$token\" ]; then\n    token=\"migrator_$(openssl rand -hex 24 2>/dev/null || tr -dc 'a-zA-Z0-9' < /dev/urandom | head -c 48)\"\n    cat <<EOF > \"$DADOS_DIR/migrator_auth.json\"\n{\n  \"token\": \"$token\",\n  \"created_at\": $(date +%s),\n  \"role\": \"admin\"\n}\nEOF\n    chmod 600 \"$DADOS_DIR/migrator_auth.json\"\n  fi\n  echo \"$token\"\n}\n\ndeploy_container() {\n  step \"2/4\" \"Preparando diret\u00f3rios e arquivos...\"\n  mkdir -p \"$INSTALL_DIR\" \"$DADOS_DIR\"\n  local script_dir\n  script_dir=\"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")\" 2>/dev/null && pwd || echo \"\")\"\n\n  if [ -n \"$script_dir\" ] && [ -d \"$script_dir/agent\" ]; then\n    cp -r \"$script_dir/agent\" \"$INSTALL_DIR/\"\n    cp \"$script_dir/docker-compose.agent.yml\" \"$INSTALL_DIR/\" 2>/dev/null || true\n  elif [ ! -d \"$INSTALL_DIR/agent\" ]; then\n    info \"Baixando arquivos do painel IMPA Migrate...\"\n    if curl -fsSL -m 15 \"https://migrator.impa365.com/impamigrate.tar.gz\" -o \"/tmp/impamigrate.tar.gz\" 2>/dev/null; then\n      tar -xzf \"/tmp/impamigrate.tar.gz\" -C \"$INSTALL_DIR\" 2>/dev/null || true\n      rm -f \"/tmp/impamigrate.tar.gz\"\n    fi\n\n    if [ ! -d \"$INSTALL_DIR/agent\" ]; then\n      info \"Clonando reposit\u00f3rio oficial...\"\n      if ! command -v git >/dev/null 2>&1; then\n        apt-get update -qq && apt-get install -y -qq git >/dev/null 2>&1 || true\n      fi\n      git clone --depth 1 https://github.com/impa365/impa-migrate.git /tmp/impa-repo-dl 2>/dev/null || true\n      if [ -d \"/tmp/impa-repo-dl/impamigrate/agent\" ]; then\n        cp -r /tmp/impa-repo-dl/impamigrate/agent \"$INSTALL_DIR/\"\n        cp /tmp/impa-repo-dl/impamigrate/docker-compose.agent.yml \"$INSTALL_DIR/\" 2>/dev/null || true\n      fi\n      rm -rf /tmp/impa-repo-dl\n    fi\n  fi\n\n  if [ ! -d \"$INSTALL_DIR/agent\" ]; then\n    die \"N\u00e3o foi poss\u00edvel obter os arquivos do painel em $INSTALL_DIR/agent\"\n  fi\n\n  step \"3/4\" \"Subindo container do Painel de Migra\u00e7\u00e3o...\"\n  docker rm -f impamigrate-agent 2>/dev/null || true\n\n  local token=\"$1\"\n  local pub_ip=\"$2\"\n\n  docker run -d \\\n    --name impamigrate-agent \\\n    --restart unless-stopped \\\n    -p \"${MIGRATOR_PORT}:8899\" \\\n    -v /var/run/docker.sock:/var/run/docker.sock \\\n    -v /root:/root \\\n    -v /var/lib/docker/volumes:/var/lib/docker/volumes \\\n    -v \"$INSTALL_DIR:/opt/impamigrate\" \\\n    -v /var/log:/var/log \\\n    -e MIGRATOR_TOKEN=\"$token\" \\\n    -e MIGRATOR_PORT=\"8899\" \\\n    -e MIGRATOR_PUBLIC_IP=\"$pub_ip\" \\\n    -e IMPA_MIGRATOR_VERSION=\"$MIGRATOR_VERSION\" \\\n    python:3.12-slim bash -c \"\n      apt-get update -qq && apt-get install -y -qq openssh-client sshpass pv curl >/dev/null 2>&1\n      && pip install -q fastapi 'uvicorn[standard]' pydantic httpx docker PyYAML jinja2 paramiko\n      && cd /opt/impamigrate/agent\n      && python -m uvicorn app:app --host 0.0.0.0 --port 8899\n    \"\n\n  ok \"Container impamigrate-agent iniciado com sucesso\"\n}\n\nwait_healthy() {\n  step \"4/4\" \"Verificando inicializa\u00e7\u00e3o da API...\"\n  local attempts=0\n  while [ $attempts -lt 25 ]; do\n    if curl -fsS -m 2 \"http://127.0.0.1:${MIGRATOR_PORT}/api/health\" >/dev/null 2>&1; then\n      ok \"Painel online e respondendo na porta ${MIGRATOR_PORT}\"\n      return 0\n    fi\n    sleep 2\n    attempts=$((attempts + 1))\n  done\n  die \"O painel demorou para inicializar. Verifique: docker logs impamigrate-agent\"\n}\n\nshow_completion() {\n  local token=\"$1\"\n  local pub_ip=\"$2\"\n  local panel_url=\"http://${pub_ip}:${MIGRATOR_PORT}/?token=${token}\"\n\n  echo \"\"\n  echo -e \"  ${GREEN}\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550${RESET}\"\n  echo -e \"  ${BOLD}${GREEN}\u2714 PAINEL IMPA MIGRATE INSTALADO COM SUCESSO!${RESET}\"\n  echo -e \"  ${GREEN}\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550${RESET}\"\n  echo \"\"\n  echo -e \"  ${BOLD}Acesse o painel pelo navegador:${RESET}\"\n  echo -e \"  ${CYAN}${BOLD}${panel_url}${RESET}\"\n  echo \"\"\n  echo -e \"  ${GRAY}Token administrativo:${RESET} ${WHITE}${token}${RESET}\"\n  echo -e \"  ${GRAY}Porta:${RESET} ${WHITE}${MIGRATOR_PORT}${RESET}\"\n  echo -e \"  ${GRAY}Logs:${RESET} ${WHITE}docker logs -f impamigrate-agent${RESET}\"\n  echo \"\"\n}\n\nmain() {\n  require_root\n  banner\n  local pub_ip\n  pub_ip=\"$(detect_public_ip)\"\n  ensure_docker\n  local token\n  token=\"$(generate_token)\"\n  deploy_container \"$token\" \"$pub_ip\"\n  wait_healthy\n  show_completion \"$token\" \"$pub_ip\"\n}\n\nmain \"$@\"\n";
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
