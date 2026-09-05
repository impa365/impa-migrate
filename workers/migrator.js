/**
 * IMPA Migrator edge worker
 * - Browser  → landing (visual alinhado a impa365.com)
 * - curl/wget → impa-migrator.sh
 * - /install  → sempre o script
 */
// Commit fixo — evita CDN da edge servir main desatualizado por POP (ex.: GRU)
const SCRIPT_COMMIT = "60bfd4b80d835cff23a0f03c711b1d65323cae5a";
const SCRIPT_URL = `https://raw.githubusercontent.com/impa365/impa-migrate/${SCRIPT_COMMIT}/impa-migrator.sh`;

const VERSION = "1.1.23";
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
  };
}

function applyEvent(stats, event) {
  const step = event.step || "unknown";
  stats.byStep[step] = (stats.byStep[step] || 0) + 1;
  if (event.version) {
    stats.byVersion[event.version] = (stats.byVersion[event.version] || 0) + 1;
  }
  if (step === "page_view") stats.pageViews += 1;
  if (step === "start") stats.started += 1;
  if (step === "migration_confirmed") stats.confirmed += 1;
  if (step === "completed") stats.completed += 1;
  if (step === "failed") stats.failed += 1;

  stats.recent.unshift(event);
  stats.recent = stats.recent.slice(0, 150);

  if (step !== "page_view" && event.ip && event.ip !== "unknown") {
    const idx = stats.servers.findIndex((s) => s.ip === event.ip);
    const row = {
      ip: event.ip,
      firstSeen: idx >= 0 ? stats.servers[idx].firstSeen : event.ts,
      lastSeen: event.ts,
      lastStep: step,
      version: event.version,
      mode: event.mode,
      run: event.run || null,
    };
    if (idx >= 0) stats.servers[idx] = { ...stats.servers[idx], ...row };
    else {
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
  const event = {
    ts: new Date().toISOString(),
    ip,
    step,
    version,
    mode: mode || null,
    run: run || null,
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
      await fetch(hook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `**IMPA Migrator**\nIP: \`${ip}\`\nEtapa: **${step}**\nVersão: ${version}${mode ? `\nModo: ${mode}` : ""}`,
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
  const serverRows = servers
    .slice(0, 80)
    .map(
      (s) =>
        `<tr><td><code>${esc(s.ip)}</code></td><td>${esc(s.lastStep)}</td><td>${esc(s.mode || "—")}</td><td>${esc(s.version || "—")}</td><td>${fmtTs(s.lastSeen)}</td></tr>`
    )
    .join("");
  const eventRows = recent
    .slice(0, 80)
    .map(
      (e) =>
        `<tr><td>${fmtTs(e.ts)}</td><td><code>${esc(e.ip)}</code></td><td>${esc(e.step)}</td><td>${esc(e.mode || "—")}</td><td>${esc(e.version || "—")}</td></tr>`
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
        <p>Quem usa, até onde chegou e quantos servidores únicos. Sem senhas ou dados de volume.</p>
      </div>
      <p>Atualiza ao recarregar</p>
    </header>
    <div class="cards">
      <div class="card"><span>Visitas no site</span><b>${stats.pageViews || 0}</b></div>
      <div class="card"><span>Servidores únicos (IP)</span><b>${stats.uniqueIps || 0}</b></div>
      <div class="card"><span>Migrações iniciadas</span><b>${stats.started || 0}</b></div>
      <div class="card"><span>Confirmadas (MIGRAR)</span><b>${stats.confirmed || 0}</b></div>
      <div class="card"><span>Concluídas</span><b>${stats.completed || 0}</b></div>
      <div class="card"><span>Falhas / abortadas</span><b>${stats.failed || 0}</b></div>
    </div>
    <h2>Funil de etapas</h2>
    <div class="box">${funnelRows || "<p>Ainda sem eventos de migração.</p>"}</div>
    <h2>Servidores alcançados</h2>
    <div class="box">
      <table>
        <thead><tr><th>IP</th><th>Última etapa</th><th>Modo</th><th>Versão</th><th>Último ping<br/><span class="tz">UTC-3 · UTC</span></th></tr></thead>
        <tbody>${serverRows || '<tr><td colspan="5">Nenhum servidor ainda.</td></tr>'}</tbody>
      </table>
    </div>
    <h2>Eventos recentes</h2>
    <div class="box">
      <table>
        <thead><tr><th>Quando<br/><span class="tz">UTC-3 · UTC</span></th><th>IP</th><th>Etapa</th><th>Modo</th><th>Versão</th></tr></thead>
        <tbody>${eventRows || '<tr><td colspan="5">Nenhum evento ainda.</td></tr>'}</tbody>
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
    if (url.pathname === TELEMETRY_PATH) {
      return handleTelemetry(request, env);
    }
    if (url.pathname === PAINEL_PATH || url.pathname === PAINEL_PATH + "/") {
      return handlePainel(request, env);
    }
    if (wantsScript(request, url.pathname)) {
      return serveScript();
    }
    return landingPage();
  },
};
