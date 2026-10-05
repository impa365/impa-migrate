#!/usr/bin/env python3
"""Build workers/setupimpa.js with embedded install.sh and tarball."""
import base64
import io
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SETUPIMPA_DIR = ROOT / "setupimpa"
INSTALL_SH = (SETUPIMPA_DIR / "install.sh").read_text(encoding="utf-8")

# 1) Build tarball of setupimpa
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w:gz") as tar:
    for f in SETUPIMPA_DIR.rglob("*"):
        if any(part in f.parts for part in (".git", "__pycache__", "dist")) or f.name.endswith(".pyc") or (f.name.startswith("_") and f.name != "__init__.py"):
            continue
        rel = f.relative_to(SETUPIMPA_DIR)
        tar.add(f, arcname=rel.as_posix(), recursive=False)

tar_bytes = buf.getvalue()
tar_b64 = base64.b64encode(tar_bytes).decode("ascii")
print(f"Tar.gz size: {len(tar_bytes)} bytes ({len(tar_bytes)/1024:.1f} KB), base64: {len(tar_b64)} chars")

WORKER_TEMPLATE = r"""/**
 * SetupImpa Cloudflare Edge Worker
 * - Browser  -> Landing page (IMPA 365)
 * - curl/wget/install -> install.sh
 * - /setupimpa.tar.gz -> full setupimpa package
 * - /telemetry -> telemetry collection (Durable Object)
 * - /painel -> dashboard
 */

const VERSION = "0.2.0";
const INSTALL_CMD = "bash <(curl -sSL https://setup.impa365.com)";

// Embedded install.sh script
const SCRIPT_CONTENT = __EMBEDDED_INSTALL_SH__;

// Embedded setupimpa.tar.gz package (base64)
const TARBALL_B64 = "__EMBEDDED_TARBALL_B64__";

function wantsScript(request, pathname) {
  if (
    pathname === "/install" ||
    pathname === "/install.sh" ||
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

function serveScript() {
  return new Response(SCRIPT_CONTENT, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-SetupImpa-Version": VERSION,
    },
  });
}

function serveTarball() {
  // Decode base64 to binary
  const binaryString = atob(TARBALL_B64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": 'attachment; filename="setupimpa.tar.gz"',
      "Cache-Control": "public, max-age=300",
    },
  });
}

const TELEMETRY_PATH = "/telemetry";
const PAINEL_PATH = "/painel";
const COOKIE_NAME = "setupimpa_admin";

function emptyStats() {
  return {
    pageViews: 0,
    started: 0,
    dockerReady: 0,
    filesInstalled: 0,
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
  const step = event.step || "unknown";

  if (step === "page_view") {
    const ip = event.ip || "unknown";
    if (!ip || ip === "unknown") return stats;
    upsertSiteVisitor(stats, event);
    const key = `${saoPauloDay(event.ts)}|${ip}`;
    stats.pageViewSeen = stats.pageViewSeen || {};
    if (stats.pageViewSeen[key]) return stats;
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
  if (step === "docker_ready") stats.dockerReady = (stats.dockerReady || 0) + 1;
  if (step === "files_installed") stats.filesInstalled = (stats.filesInstalled || 0) + 1;
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
  return env.TELEMETRY_DO.get(env.TELEMETRY_DO.idFromName("setupimpa-global"));
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
    run: run || null,
    country: country || null,
    city: city || null,
    region: region || null,
  };
  try {
    await persistEvent(env, event);
  } catch (e) {
    console.log("[SETUPIMPA_TELEMETRY] failed", e?.message || e);
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
  return sha256hex("setupimpa-painel-v1:" + password);
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
<title>Painel SetupImpa</title>
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
    <h1>SetupImpa Telemetria</h1>
    <p>Acesso restrito — IMPA 365</p>
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

function dashboardPage(stats) {
  const servers = stats.servers || [];
  const visitors = stats.visitors || [];
  const recent = stats.recent || [];
  const funnelOrder = [
    "start",
    "docker_ready",
    "files_installed",
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

  const html = `<!DOCTYPE html>
<html lang="pt-BR"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex,nofollow"/>
<title>Painel SetupImpa</title>
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
  code{font-family:ui-monospace,Consolas,monospace;color:var(--cyan)}
  .box{background:var(--elev);border:1px solid var(--border);border-radius:12px;padding:1rem;overflow:auto}
  @media (max-width:800px){ .cards{grid-template-columns:1fr 1fr} .funnel-row{grid-template-columns:1fr} }
</style></head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>SetupImpa · telemetria</h1>
        <p>Instalações, servidores alcançados e visitas.</p>
      </div>
      <p>Atualiza ao recarregar</p>
    </header>
    <div class="cards">
      <div class="card"><span>Visitantes únicos (IP/dia)</span><b>${stats.pageViews || 0}</b></div>
      <div class="card"><span>Servidores únicos (IP)</span><b>${stats.uniqueIps || 0}</b></div>
      <div class="card"><span>Instalações iniciadas</span><b>${stats.started || 0}</b></div>
      <div class="card"><span>Docker pronto</span><b>${stats.dockerReady || 0}</b></div>
      <div class="card"><span>Concluídas com sucesso</span><b>${stats.completed || 0}</b></div>
      <div class="card"><span>Falhas</span><b>${stats.failed || 0}</b></div>
    </div>
    <h2>Funil de etapas</h2>
    <div class="box">${funnelRows || "<p>Ainda sem eventos de instalação.</p>"}</div>
    <h2>Servidores que rodaram o SetupImpa</h2>
    <div class="box">
      <table>
        <thead><tr><th>IP</th><th>Local</th><th>Última etapa</th><th>Versão</th><th>Último ping</th></tr></thead>
        <tbody>${
          servers.slice(0, 80).map((s) => `<tr><td><code>${esc(s.ip)}</code></td><td>${esc(formatLoc(s))}</td><td>${esc(s.lastStep)}</td><td>${esc(s.version || "—")}</td><td>${esc(s.lastSeen)}</td></tr>`).join("") || '<tr><td colspan="5">Nenhum servidor ainda.</td></tr>'
        }</tbody>
      </table>
    </div>
  </div>
</body></html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}

async function handlePainel(request, env) {
  if (!env?.ADMIN_PASSWORD) {
    return new Response("Painel sem senha configurada.", {
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
  <title>SetupImpa — Instalador Automático de Servidores | IMPA 365</title>
  <meta name="description" content="Instale WhatsApp, Banco de Dados, Robôs e Sistemas no seu servidor em segundos. Feito para qualquer pessoa usar sem complicação." />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Space+Grotesk:wght@600;700&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #090a10;
      --bg-card: #12141e;
      --fg: #f8fafc;
      --muted: #94a3b8;
      --primary: #6366f1;
      --primary-hover: #4f46e5;
      --primary-glow: rgba(99, 102, 241, 0.35);
      --cyan: #38bdf8;
      --green: #10b981;
      --border: rgba(255, 255, 255, 0.08);
      --radius: 14px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      min-height: 100vh;
      overflow-x: hidden;
      font-family: "Plus Jakarta Sans", system-ui, -apple-system, sans-serif;
      color: var(--fg);
      background:
        radial-gradient(800px 500px at 50% -5%, rgba(99, 102, 241, 0.25), transparent 60%),
        radial-gradient(600px 400px at 90% 20%, rgba(56, 189, 248, 0.12), transparent 50%),
        var(--bg);
      line-height: 1.6;
    }
    a { color: var(--cyan); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .wrap { width: min(1120px, calc(100% - 2rem)); margin: 0 auto; }

    /* Nav */
    .nav {
      display: flex; align-items: center; justify-content: space-between;
      padding: 1.5rem 0;
      border-bottom: 1px solid var(--border);
    }
    .logo {
      display: flex; align-items: center; gap: 0.6rem;
      font-family: "Space Grotesk", sans-serif;
      font-weight: 700; font-size: 1.25rem;
      color: var(--fg); text-decoration: none;
    }
    .logo span { color: #818cf8; }
    .logo-badge {
      font-size: 0.7rem; font-weight: 600;
      background: rgba(99, 102, 241, 0.15);
      border: 1px solid rgba(99, 102, 241, 0.3);
      padding: 0.2rem 0.55rem; border-radius: 999px;
      color: #a5b4fc;
    }
    .nav-links { display: flex; gap: 1.5rem; align-items: center; font-size: 0.92rem; }
    .nav-links a { color: var(--muted); }
    .nav-links a:hover { color: var(--fg); }

    /* Hero */
    .hero {
      padding: 4.5rem 0 3.5rem;
      text-align: center;
      display: flex; flex-direction: column; align-items: center;
    }
    .eyebrow {
      display: inline-flex; align-items: center; gap: 0.5rem;
      font-size: 0.8rem; font-weight: 700; letter-spacing: 0.08em;
      text-transform: uppercase; color: #a5b4fc;
      background: rgba(99, 102, 241, 0.12);
      border: 1px solid rgba(99, 102, 241, 0.25);
      padding: 0.35rem 0.9rem; border-radius: 999px;
      margin-bottom: 1.5rem;
    }
    .hero h1 {
      font-family: "Space Grotesk", sans-serif;
      font-weight: 800;
      font-size: clamp(2rem, 5.5vw, 3.4rem);
      line-height: 1.15;
      letter-spacing: -0.02em;
      max-width: 22ch;
      margin-bottom: 1.25rem;
    }
    .hero h1 em {
      font-style: normal;
      background: linear-gradient(135deg, #a5b4fc, #818cf8, #38bdf8);
      -webkit-background-clip: text; background-clip: text;
      color: transparent;
    }
    .lead {
      max-width: 42rem;
      color: var(--muted);
      font-size: clamp(1.05rem, 2vw, 1.2rem);
      margin-bottom: 2.5rem;
    }

    /* Terminal One-liner */
    .terminal-container {
      width: min(760px, 100%);
      margin-bottom: 1.5rem;
    }
    .terminal-label {
      font-size: 0.85rem; font-weight: 600; color: #a5b4fc;
      margin-bottom: 0.6rem; display: flex; align-items: center; justify-content: center; gap: 0.4rem;
    }
    .terminal {
      border: 1px solid rgba(99, 102, 241, 0.35);
      border-radius: var(--radius);
      background: #0d0f18;
      box-shadow: 0 0 0 1px rgba(99,102,241,0.1), 0 20px 60px -20px var(--primary-glow);
      overflow: hidden;
      text-align: left;
    }
    .terminal-bar {
      display: flex; align-items: center; justify-content: space-between;
      padding: 0.75rem 1.1rem;
      border-bottom: 1px solid var(--border);
      background: #08090e;
    }
    .dots { display: flex; gap: 0.45rem; }
    .dot { width: 10px; height: 10px; border-radius: 50%; }
    .dot.r { background: #ef4444; }
    .dot.y { background: #f59e0b; }
    .dot.g { background: #10b981; }
    .terminal-title {
      font-size: 0.78rem; color: var(--muted); font-family: monospace;
    }
    .terminal-body {
      display: flex; flex-wrap: wrap; gap: 1rem; align-items: center;
      padding: 1.25rem 1.25rem 1.35rem;
    }
    .terminal-body code {
      flex: 1 1 260px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.95rem;
      color: #7dd3fc;
      word-break: break-all;
      user-select: all;
    }
    .btn-copy {
      border: 0; cursor: pointer;
      font-family: inherit; font-weight: 700; font-size: 0.92rem;
      padding: 0.85rem 1.35rem;
      border-radius: 10px;
      color: #fff;
      background: var(--primary);
      box-shadow: 0 4px 14px var(--primary-glow);
      transition: all 0.15s ease;
      white-space: nowrap;
    }
    .btn-copy:hover {
      background: var(--primary-hover);
      transform: translateY(-1px);
    }
    .btn-copy.ok {
      background: var(--green);
      box-shadow: 0 4px 14px rgba(16, 185, 129, 0.4);
    }

    .req {
      font-size: 0.88rem; color: var(--muted);
      display: flex; align-items: center; gap: 0.5rem; justify-content: center;
      margin-bottom: 2rem;
    }
    .req strong { color: var(--fg); }

    /* Visual 3 Steps */
    .steps-section {
      padding: 4rem 0;
      border-top: 1px solid var(--border);
    }
    .section-head {
      text-align: center; margin-bottom: 3rem;
    }
    .section-head h2 {
      font-family: "Space Grotesk", sans-serif;
      font-size: clamp(1.6rem, 3.5vw, 2.2rem);
      margin-bottom: 0.6rem;
    }
    .section-head p {
      color: var(--muted); max-width: 36rem; margin: 0 auto; font-size: 1.05rem;
    }

    .steps-grid {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.5rem;
    }
    .step-card {
      padding: 2rem 1.6rem;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg-card);
      text-align: left;
      position: relative;
    }
    .step-number {
      font-family: "Space Grotesk", sans-serif;
      font-size: 2.25rem; font-weight: 800; color: #818cf8;
      line-height: 1; margin-bottom: 1rem;
    }
    .step-card h3 {
      font-size: 1.15rem; font-weight: 700; margin-bottom: 0.5rem;
    }
    .step-card p {
      color: var(--muted); font-size: 0.92rem; line-height: 1.5;
    }

    /* Marquee */
    /* __MARQUEE_CSS__ */

    /* FAQ */
    .faq-section {
      padding: 4rem 0;
      border-top: 1px solid var(--border);
    }
    .faq-box { max-width: 780px; margin: 0 auto; }
    details {
      border-bottom: 1px solid var(--border);
      padding: 1.25rem 0;
    }
    details summary {
      cursor: pointer; list-style: none;
      font-weight: 700; font-size: 1.05rem;
      display: flex; justify-content: space-between; align-items: center; gap: 1rem;
    }
    details summary::-webkit-details-marker { display: none; }
    details summary::after {
      content: "+"; font-size: 1.4rem; color: #818cf8; font-weight: 700;
    }
    details[open] summary::after { content: "–"; }
    details p {
      margin-top: 0.85rem; color: var(--muted); font-size: 0.95rem; line-height: 1.6;
    }

    /* Footer */
    footer {
      border-top: 1px solid var(--border);
      padding: 2.5rem 0 3.5rem;
      display: flex; flex-wrap: wrap; gap: 1.5rem;
      justify-content: space-between; align-items: center;
      color: var(--muted); font-size: 0.88rem;
    }
    footer strong { color: var(--fg); }

    @media (max-width: 800px) {
      .steps-grid { grid-template-columns: 1fr; }
      .integrations-grid { grid-template-columns: 1fr; }
      .hero { padding: 3rem 0 2rem; }
      .terminal-body { flex-direction: column; align-items: stretch; }
      .btn-copy { width: 100%; text-align: center; }
    }

    /* Hero Highlights Badges */
    .hero-highlights {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 0.65rem;
      margin-bottom: 2rem;
    }
    .hl-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      padding: 0.45rem 0.95rem;
      border-radius: 999px;
      font-size: 0.82rem;
      font-weight: 700;
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.04);
      color: var(--fg);
      backdrop-filter: blur(8px);
    }
    .hl-badge.cf {
      border-color: rgba(243, 128, 32, 0.35);
      background: rgba(243, 128, 32, 0.08);
      color: #fb923c;
    }
    .hl-badge.mcp {
      border-color: rgba(99, 102, 241, 0.4);
      background: rgba(99, 102, 241, 0.1);
      color: #a5b4fc;
    }
    .hl-badge.ssl {
      border-color: rgba(16, 185, 129, 0.35);
      background: rgba(16, 185, 129, 0.08);
      color: #34d399;
    }

    /* Integrations Section */
    .integrations-section {
      padding: 4.5rem 0 3.5rem;
      border-top: 1px solid var(--border);
    }
    .integrations-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 2rem;
      margin-top: 2rem;
    }
    .integration-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 2.2rem 2rem;
      display: flex;
      flex-direction: column;
      position: relative;
      overflow: hidden;
      transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
    }
    .integration-card:hover {
      transform: translateY(-3px);
    }
    .integration-card.cf:hover {
      border-color: rgba(243, 128, 32, 0.5);
      box-shadow: 0 16px 40px -12px rgba(243, 128, 32, 0.2);
    }
    .integration-card.mcp:hover {
      border-color: rgba(99, 102, 241, 0.5);
      box-shadow: 0 16px 40px -12px rgba(99, 102, 241, 0.25);
    }
    .int-tag-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1.25rem;
    }
    .int-badge {
      font-size: 0.72rem;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 0.3rem 0.75rem;
      border-radius: 999px;
    }
    .int-badge.cf {
      background: rgba(243, 128, 32, 0.15);
      color: #fb923c;
      border: 1px solid rgba(243, 128, 32, 0.35);
    }
    .int-badge.mcp {
      background: rgba(99, 102, 241, 0.15);
      color: #a5b4fc;
      border: 1px solid rgba(99, 102, 241, 0.35);
    }
    .int-icon-box {
      width: 48px;
      height: 48px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.6rem;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border);
    }
    .integration-card h3 {
      font-family: "Space Grotesk", sans-serif;
      font-size: 1.45rem;
      margin-bottom: 0.65rem;
      color: var(--fg);
    }
    .integration-card .int-lead {
      color: var(--muted);
      font-size: 0.95rem;
      line-height: 1.55;
      margin-bottom: 1.5rem;
    }
    .int-features-list {
      list-style: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      margin-top: auto;
    }
    .int-features-list li {
      font-size: 0.88rem;
      color: #cbd5e1;
      display: flex;
      align-items: flex-start;
      gap: 0.65rem;
      line-height: 1.45;
    }
    .int-features-list li .int-check {
      color: #34d399;
      font-weight: 800;
      flex-shrink: 0;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <nav class="nav">
      <a class="logo" href="https://setup.impa365.com">
        🚀 Setup<span>Impa</span>
        <span class="logo-badge">v${VERSION}</span>
      </a>
      <div class="nav-links">
        <a href="https://impa365.com" target="_blank" rel="noopener">IMPA 365</a>
        <a href="https://github.com/impa365/setupImpa" target="_blank" rel="noopener">GitHub</a>
        <a href="/painel">Telemetria</a>
      </div>
    </nav>

    <header class="hero">
      <div class="eyebrow">✨ Instalador de Servidores para Qualquer Pessoa</div>
      <h1>Instale seus Sistemas no Servidor em <em>1 Minuto</em></h1>
      <p class="lead">
        Conecte WhatsApp (Evolution API), Banco de Dados, Robôs com Inteligência Artificial e Checkout de Vendas sem precisar entender nada de programação ou comandos difíceis.
      </p>

      <div class="hero-highlights">
        <span class="hl-badge cf">☁️ Automação Cloudflare DNS</span>
        <span class="hl-badge mcp">🤖 Servidor MCP Nativo (Cursor & Claude)</span>
        <span class="hl-badge ssl">🔒 SSL Automático Traefik v3</span>
      </div>

      <div class="terminal-container">
        <div class="terminal-label">👇 Copie este comando e cole no terminal da sua VPS:</div>
        <div class="terminal" aria-label="Comando de instalação">
          <div class="terminal-bar">
            <div class="dots">
              <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
            </div>
            <span class="terminal-title">Terminal · root@servidor</span>
          </div>
          <div class="terminal-body">
            <code id="install-cmd">${INSTALL_CMD}</code>
            <button type="button" class="btn-copy" id="copy-btn">📋 Copiar Comando</button>
          </div>
        </div>
      </div>

      <div class="req">
        <span>✔ Funciona em qualquer servidor novo com <strong>Ubuntu 22/24</strong> ou <strong>Debian 11/12</strong></span>
      </div>
    </header>

    <section class="steps-section" id="como">
      <div class="section-head">
        <h2>Como Funciona? (É só isso!)</h2>
        <p>Criamos um fluxo 100% automatizado para que você não precise digitar linhas de comando complexas.</p>
      </div>

      <div class="steps-grid">
        <div class="step-card">
          <div class="step-number">01</div>
          <h3>Copie o comando</h3>
          <p>Clique no botão azul acima para copiar o comando oficial do instalador.</p>
        </div>
        <div class="step-card">
          <div class="step-number">02</div>
          <h3>Cole no seu servidor</h3>
          <p>Abra o terminal da sua VPS (ou aplicativo PuTTY) e cole o comando dando Enter.</p>
        </div>
        <div class="step-card">
          <div class="step-number">03</div>
          <h3>Abra no navegador</h3>
          <p>Em menos de 1 minuto, um link vai aparecer na sua tela. Basta clicar e instalar o que quiser com 1 clique!</p>
        </div>
      </div>
    </section>

    <section class="integrations-section" id="integracoes">
      <div class="section-head">
        <h2>Integrações Nativas & Inteligência Artificial</h2>
        <p>Automação completa de infraestrutura na Cloudflare e controle total da sua VPS por IA através do protocolo oficial Model Context Protocol (MCP).</p>
      </div>

      <div class="integrations-grid">
        <div class="integration-card cf">
          <div class="int-tag-row">
            <span class="int-badge cf">CLOUDFLARE DNS AUTOMATION</span>
            <div class="int-icon-box">☁️</div>
          </div>
          <h3>Apontamento de DNS na Cloudflare em 1 Clique</h3>
          <p class="int-lead">
            Chega de criar registros tipo A na mão. Conecte seu token de API da Cloudflare no SetupImpa e deixe que o sistema aponte e configure seus subdomínios automaticamente a cada aplicação instalada.
          </p>
          <ul class="int-features-list">
            <li><span class="int-check">✔</span> <div><strong>Criação Instantânea de Subdomínios:</strong> Digite o endereço desejado (ex: <code>chat.suaempresa.com</code>) e o registro é criado na Cloudflare em segundos.</div></li>
            <li><span class="int-check">✔</span> <div><strong>Alternância Proxy / DNS Only:</strong> Escolha com 1 clique se deseja ativar o proxy de proteção Cloudflare ou modo direto para WebSockets de WhatsApp.</div></li>
            <li><span class="int-check">✔</span> <div><strong>Auto-Detecção de Zonas:</strong> O SetupImpa localiza automaticamente o domínio raiz associado na sua conta Cloudflare sem configuração manual.</div></li>
          </ul>
        </div>

        <div class="integration-card mcp">
          <div class="int-tag-row">
            <span class="int-badge mcp">MODEL CONTEXT PROTOCOL (MCP)</span>
            <div class="int-icon-box">🤖</div>
          </div>
          <h3>Controle sua VPS com Agentes de IA via MCP</h3>
          <p class="int-lead">
            Conecte o <strong>Cursor IDE</strong>, <strong>Claude Desktop</strong> ou o agente autônomo <strong>Hermes</strong> diretamente ao seu servidor. A IA ganha 16 ferramentas de DevOps para monitorar e gerenciar sua máquina em linguagem natural.
          </p>
          <ul class="int-features-list">
            <li><span class="int-check">✔</span> <div><strong>Diagnóstico de Saúde em Tempo Real:</strong> Peça à IA para checar consumo de RAM, CPU, disco e integridade do cluster Docker Swarm.</div></li>
            <li><span class="int-check">✔</span> <div><strong>Instalação por Linguagem Natural:</strong> Diga no chat <em>"Instale o N8N e a Evolution API no meu servidor"</em> e o agente executa a instalação completa.</div></li>
            <li><span class="int-check">✔</span> <div><strong>Leitura de Logs & Resolução de Falhas:</strong> O agente lê logs dos containers em tempo real para depurar e reiniciar serviços autonomamente.</div></li>
          </ul>
        </div>
      </div>
    </section>
  </div>

  <!-- __MARQUEE_SECTION__ -->

  <div class="wrap">
    <section class="faq-section" id="duvidas">
      <div class="section-head">
        <h2>Perguntas Frequentes</h2>
        <p>Tire suas dúvidas de forma rápida e direta.</p>
      </div>

      <div class="faq-box">
        <details>
          <summary>Como funciona a integração com a Cloudflare?</summary>
          <p>Basta colar seu Token da API da Cloudflare na aba <strong>Cloudflare DNS</strong> do painel do SetupImpa. A partir desse momento, sempre que você for instalar uma aplicação (como Evolution API, N8N, Chatwoot ou Dify), o SetupImpa cria e aponta o subdomínio correspondente automaticamente na sua conta Cloudflare em segundos, sem você precisar abrir o site da Cloudflare.</p>
        </details>

        <details>
          <summary>O que é o Servidor MCP e como conectar agentes de IA?</summary>
          <p>O SetupImpa possui um servidor nativo do <strong>Model Context Protocol (MCP)</strong> rodando na porta <code>:8877</code> com transporte SSE oficial e HTTP JSON-RPC. Com ele, você pode conectar assistentes como o <strong>Cursor IDE</strong>, <strong>Claude Desktop</strong> ou o <strong>Hermes</strong> diretamente à sua VPS. Seu assistente ganha 16 ferramentas integradas para monitorar recursos, ler logs e instalar aplicações conversando com você em português.</p>
        </details>

        <details>
          <summary>Eu não entendo de VPS ou programação, consigo usar?</summary>
          <p>Sim! O SetupImpa foi feito exatamente para quem não entende de parte técnica. Você só precisa copiar o comando de instalação, colar no terminal uma única vez e depois controlar tudo por um painel bonito no seu navegador, clicando com o mouse.</p>
        </details>

        <details>
          <summary>O que é uma VPS afinal?</summary>
          <p>Pense na VPS como um computador na nuvem que fica ligado 24 horas por dia, 7 dias por semana na internet. É lá que suas ferramentas e robôs de WhatsApp vão rodar para nunca caírem, mesmo que seu computador de casa esteja desligado.</p>
        </details>

        <details>
          <summary>Posso instalar mais de um WhatsApp (Evolution API)?</summary>
          <p>Sim! Você pode criar 2, 5, 10 instâncias diferentes da Evolution API na mesma VPS. Cada uma terá seu próprio endereço na internet e seu próprio banco de dados isolado.</p>
        </details>

        <details>
          <summary>Meus sites vão ter cadeado de segurança (HTTPS/SSL)?</summary>
          <p>Sim! O SetupImpa já vem com emissão automática de certificado SSL gratuito (Let's Encrypt). Todas as suas ferramentas abrem com <code>https://</code> seguro e cadeado verde.</p>
        </details>

        <details>
          <summary>Posso compartilhar ou revender esse instalador?</summary>
          <p>Sim! Você tem total liberdade para usar, modificar, compartilhar ou até vender serviços usando o SetupImpa, desde que <strong>mantenha visíveis os créditos obrigatórios:</strong> "Baseado em SetupImpa — Desenvolvido por IMPA 365" e mencione a referência ao SetupOrion.</p>
        </details>
      </div>
    </section>

    <footer>
      <div>
        <strong>IMPA 365</strong> · Desenvolvido por IMPA 365<br>
        <span style="opacity:.75">Inspirado na arquitetura do SetupOrion (Orion Design)</span>
      </div>
      <div>
        <a href="https://impa365.com" target="_blank" rel="noopener">impa365.com</a>
        ·
        <a href="https://github.com/impa365/setupImpa" target="_blank" rel="noopener">GitHub</a>
        ·
        <a href="/install">Comando Direto</a>
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
        btn.textContent = "✔ Copiado com Sucesso!";
        btn.classList.add("ok");
        setTimeout(() => {
          btn.textContent = "📋 Copiar Comando";
          btn.classList.remove("ok");
        }, 3000);
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
      "X-SetupImpa": "landing",
      "X-SetupImpa-Version": VERSION,
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "Content-Type": "text/plain" } });
    }
    if (url.pathname === "/setupimpa.tar.gz" || url.pathname === "/archive.tar.gz") {
      return serveTarball();
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
"""

import json
import sys
sys.path.insert(0, str(Path(__file__).parent))
from marquee_generator import generate_marquee_bundle
marquee_html, marquee_css = generate_marquee_bundle()

worker_code = WORKER_TEMPLATE.replace(
    "/* __MARQUEE_CSS__ */",
    marquee_css
).replace(
    "<!-- __MARQUEE_SECTION__ -->",
    marquee_html
).replace(
    "__EMBEDDED_INSTALL_SH__",
    json.dumps(INSTALL_SH)
).replace(
    "__EMBEDDED_TARBALL_B64__",
    tar_b64
)

output_path = ROOT / "workers" / "setupimpa.js"
output_path.parent.mkdir(parents=True, exist_ok=True)
output_path.write_text(worker_code, encoding="utf-8")
print(f"Generated {output_path} ({output_path.stat().st_size} bytes, {output_path.stat().st_size/1024:.1f} KB)")
