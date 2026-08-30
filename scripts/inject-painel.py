#!/usr/bin/env python3
"""Inject KV telemetry + /painel admin into workers/migrator.js (UTF-8)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / "workers" / "migrator.js"
text = path.read_text(encoding="utf-8")

NEW_TELEMETRY = r'''
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

async function loadStats(env) {
  if (!env?.TELEMETRY) return emptyStats();
  try {
    const raw = await env.TELEMETRY.get("stats");
    if (!raw) return emptyStats();
    const data = JSON.parse(raw);
    return { ...emptyStats(), ...data };
  } catch {
    return emptyStats();
  }
}

async function persistEvent(env, event) {
  if (!env?.TELEMETRY) return;
  const stats = await loadStats(env);
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

  await env.TELEMETRY.put("stats", JSON.stringify(stats));
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
        `<tr><td><code>${esc(s.ip)}</code></td><td>${esc(s.lastStep)}</td><td>${esc(s.mode || "—")}</td><td>${esc(s.version || "—")}</td><td>${esc((s.lastSeen || "").replace("T", " ").slice(0, 19))}</td></tr>`
    )
    .join("");
  const eventRows = recent
    .slice(0, 80)
    .map(
      (e) =>
        `<tr><td>${esc((e.ts || "").replace("T", " ").slice(0, 19))}</td><td><code>${esc(e.ip)}</code></td><td>${esc(e.step)}</td><td>${esc(e.mode || "—")}</td><td>${esc(e.version || "—")}</td></tr>`
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
        <thead><tr><th>IP</th><th>Última etapa</th><th>Modo</th><th>Versão</th><th>Último ping</th></tr></thead>
        <tbody>${serverRows || '<tr><td colspan="5">Nenhum servidor ainda.</td></tr>'}</tbody>
      </table>
    </div>
    <h2>Eventos recentes</h2>
    <div class="box">
      <table>
        <thead><tr><th>Quando (UTC)</th><th>IP</th><th>Etapa</th><th>Modo</th><th>Versão</th></tr></thead>
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

'''

start = text.find("const TELEMETRY_PATH")
end = text.find("function landingPage()")
if start < 0 or end < 0:
    raise SystemExit(f"anchors missing start={start} end={end}")

text = text[:start] + NEW_TELEMETRY + text[end:]
text = text.replace('const VERSION = "1.1.21";', 'const VERSION = "1.1.22";')

old_fetch = '''    if (url.pathname === TELEMETRY_PATH) {
      return handleTelemetry(request, env);
    }
    if (wantsScript(request, url.pathname)) {'''
new_fetch = '''    if (url.pathname === TELEMETRY_PATH) {
      return handleTelemetry(request, env);
    }
    if (url.pathname === PAINEL_PATH || url.pathname === PAINEL_PATH + "/") {
      return handlePainel(request, env);
    }
    if (wantsScript(request, url.pathname)) {'''
if old_fetch not in text:
    raise SystemExit("fetch handler anchor missing")
text = text.replace(old_fetch, new_fetch)

path.write_text(text, encoding="utf-8", newline="\n")
print("patched", path.stat().st_size, path.read_bytes()[:12])
