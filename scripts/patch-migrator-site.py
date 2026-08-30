#!/usr/bin/env python3
"""Patch migrator.js: CTAs, Hosteg promo, telemetry endpoint."""
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / "workers" / "migrator.js"
data = subprocess.check_output(
    ["git", "-C", str(ROOT), "show", "fc2714e:workers/migrator.js"]
).decode("utf-8")

# version bump
data = data.replace('const VERSION = "1.1.20";', 'const VERSION = "1.1.21";')

# --- telemetry helpers (insert before landingPage) ---
telemetry_js = '''
const TELEMETRY_PATH = "/telemetry";
const WHATSAPP_ASSISTED =
  "https://wa.me/557398631289?text=" +
  encodeURIComponent("Quero contratar a migração assistida");
const HOSTEG_VPS_16GB =
  "https://painel.hosteg.com.br/?cmd=cart&action=add&id=31&cycle=a&promocode=impa65";
const HOSTEG_AFFILIATE = "https://painel.hosteg.com.br/?affid=2&affplan=1";

async function handleTelemetry(request) {
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
    ua: (request.headers.get("User-Agent") || "").slice(0, 120),
  };
  console.log("[IMPA_TELEMETRY]", JSON.stringify(event));
  // Opcional: encaminhar para webhook (configure no Worker: TELEMETRY_WEBHOOK)
  const hook = typeof TELEMETRY_WEBHOOK !== "undefined" ? TELEMETRY_WEBHOOK : null;
  if (hook) {
    try {
      await fetch(hook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `**IMPA Migrator**\\nIP: \\`${ip}\\`\\nEtapa: **${step}**\\nVersão: ${version}${mode ? `\\nModo: ${mode}` : ""}`,
        }),
      });
    } catch (e) {
      console.log("[IMPA_TELEMETRY] webhook failed", e?.message || e);
    }
  }
  return new Response(null, { status: 204 });
}

'''

insert_at = "function landingPage() {"
if insert_at not in data:
    raise SystemExit("anchor not found for telemetry")
data = data.replace(insert_at, telemetry_js + insert_at)

# --- promo CSS ---
promo_css = """
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
"""

data = data.replace(
    "    @media (max-width: 800px) {",
    promo_css
    + "\n    @media (max-width: 800px) {\n      .promo-grid { grid-template-columns: 1fr; }",
)

# --- HTML banners after stats strip ---
promo_html = """
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
"""

data = data.replace(
    """      <div class="stats" aria-label="Destaques">""",
    promo_html + '\n      <div class="stats" aria-label="Destaques">',
)

# --- telemetry in fetch handler ---
data = data.replace(
    """    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "Content-Type": "text/plain" } });
    }""",
    """    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "Content-Type": "text/plain" } });
    }
    if (url.pathname === TELEMETRY_PATH) {
      return handleTelemetry(request);
    }""",
)

# --- page view telemetry ---
data = data.replace(
    """    btn.addEventListener("click", async () => {""",
    """    fetch("/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: "page_view", version: "${VERSION}" }),
    }).catch(() => {});

    btn.addEventListener("click", async () => {""",
)

path.write_text(data, encoding="utf-8", newline="\n")
print("patched", path, path.stat().st_size, "bytes")
