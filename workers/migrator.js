/**
 * IMPA Migrator edge worker
 * - Browser  → landing page
 * - curl/wget → impa-migrator.sh (GitHub raw)
 * - /install  → always the script
 */
const SCRIPT_URL =
  "https://raw.githubusercontent.com/impa365/impa-migrate/main/impa-migrator.sh";

const VERSION = "1.1.0";
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
  // Browsers send text/html; curl typically sends */*
  if (accept.includes("text/html")) return false;
  if (!ua.includes("mozilla")) return true;
  return false;
}

async function serveScript() {
  const upstream = await fetch(SCRIPT_URL, {
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      "X-IMPA-Migrator": "script",
      "X-IMPA-Version": VERSION,
    },
  });
}

function landingPage() {
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>IMPA Migrator — migre sua VPS Docker</title>
  <meta name="description" content="One-liner da IMPA 365 para migrar Docker Swarm, Portainer, stacks e volumes entre VPS." />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=Fraunces:opsz,wght@9..144,500;9..144,700&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg0: #07131a;
      --bg1: #0c2430;
      --ink: #e8f2f4;
      --muted: #9bb4bc;
      --accent: #2fd3a4;
      --accent-2: #f0b429;
      --line: rgba(232, 242, 244, 0.12);
      --glow: rgba(47, 211, 164, 0.22);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      min-height: 100vh;
      font-family: "Instrument Sans", system-ui, sans-serif;
      color: var(--ink);
      background:
        radial-gradient(1000px 600px at 12% -10%, var(--glow), transparent 55%),
        radial-gradient(800px 500px at 95% 10%, rgba(240, 180, 41, 0.12), transparent 50%),
        linear-gradient(165deg, var(--bg0), var(--bg1) 45%, #081820);
      line-height: 1.5;
    }
    .wrap { width: min(1080px, calc(100% - 2.5rem)); margin: 0 auto; }
    header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 1.4rem 0 0.5rem;
    }
    .brand {
      font-weight: 700; letter-spacing: 0.04em; font-size: 0.95rem;
      text-transform: uppercase;
    }
    .brand span { color: var(--accent); }
    .ver {
      color: var(--muted); font-size: 0.85rem;
      border: 1px solid var(--line); border-radius: 999px;
      padding: 0.35rem 0.75rem;
    }
    .hero {
      min-height: calc(100vh - 5rem);
      display: grid; align-content: center;
      padding: 2.5rem 0 4rem;
      gap: 1.25rem;
    }
    .hero h1 {
      font-family: Fraunces, Georgia, serif;
      font-weight: 700;
      font-size: clamp(2.6rem, 7vw, 4.6rem);
      line-height: 1.02;
      max-width: 12ch;
      letter-spacing: -0.02em;
    }
    .hero p.lead {
      max-width: 38rem;
      color: var(--muted);
      font-size: clamp(1.05rem, 2.2vw, 1.25rem);
    }
    .cmd {
      margin-top: 0.75rem;
      display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: stretch;
      max-width: 46rem;
    }
    .cmd code {
      flex: 1 1 280px;
      background: rgba(0,0,0,0.35);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 1rem 1.1rem;
      font-size: 0.92rem;
      overflow-x: auto;
      white-space: nowrap;
      color: #d7fff1;
    }
    .cmd button {
      border: 0; cursor: pointer;
      background: var(--accent); color: #042018;
      font-weight: 700; font-size: 0.95rem;
      border-radius: 12px; padding: 0 1.25rem;
      min-height: 52px;
      transition: transform 0.15s ease, filter 0.15s ease;
    }
    .cmd button:hover { transform: translateY(-1px); filter: brightness(1.05); }
    .cmd button.copied { background: var(--accent-2); color: #1a1200; }
    .note { color: var(--muted); font-size: 0.92rem; }
    .note strong { color: var(--ink); font-weight: 600; }
    section.steps {
      padding: 3.5rem 0 4.5rem;
      border-top: 1px solid var(--line);
    }
    section.steps h2 {
      font-family: Fraunces, Georgia, serif;
      font-size: clamp(1.8rem, 4vw, 2.4rem);
      margin-bottom: 1.75rem;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1.25rem;
    }
    @media (max-width: 800px) {
      .grid { grid-template-columns: 1fr; }
    }
    .step {
      padding: 1.25rem 0;
      border-top: 1px solid var(--line);
    }
    .step .n {
      color: var(--accent); font-weight: 700; font-size: 0.85rem;
      letter-spacing: 0.08em; text-transform: uppercase;
      margin-bottom: 0.5rem;
    }
    .step h3 { font-size: 1.15rem; margin-bottom: 0.35rem; }
    .step p { color: var(--muted); font-size: 0.98rem; }
    footer {
      border-top: 1px solid var(--line);
      padding: 1.5rem 0 2.5rem;
      color: var(--muted); font-size: 0.9rem;
      display: flex; flex-wrap: wrap; gap: 0.75rem 1.5rem;
      justify-content: space-between;
    }
    footer a { color: var(--accent); text-decoration: none; }
    footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="brand">IMPA <span>365</span> · Migrator</div>
      <div class="ver">v. ${VERSION}</div>
    </header>

    <main class="hero">
      <h1>Migre sua VPS Docker em um comando.</h1>
      <p class="lead">
        Leva Swarm, Portainer, stacks e volumes para uma VPS nova — sem reinstalar tudo na mão.
        Rode na origem. Destino limpo. A IMPA cuida do resto.
      </p>
      <div class="cmd">
        <code id="install-cmd">${INSTALL_CMD}</code>
        <button type="button" id="copy-btn">Copiar código</button>
      </div>
      <p class="note">
        <strong>Requisitos:</strong> origem com Docker Swarm · destino Debian/Ubuntu limpo · mesma arquitetura.
        Backup da VPS altamente recomendado.
      </p>
    </main>

    <section class="steps" id="como">
      <h2>Três passos.</h2>
      <div class="grid">
        <article class="step">
          <div class="n">Passo 01</div>
          <h3>Copie o comando</h3>
          <p>Cole no SSH da VPS antiga (root). O script baixa e inicia o wizard.</p>
        </article>
        <article class="step">
          <div class="n">Passo 02</div>
          <h3>Informe a VPS nova</h3>
          <p>IP, SSH e modo teste ou cutover. Confirme o backup e digite MIGRAR.</p>
        </article>
        <article class="step">
          <div class="n">Passo 03</div>
          <h3>Aponte o DNS</h3>
          <p>Quando validar, mude os A records para o IP novo. A origem não é apagada.</p>
        </article>
      </div>
    </section>

    <footer>
      <div>© IMPA 365 — créditos ao usar o Migrator.</div>
      <div>
        <a href="https://impa365.com" rel="noopener">impa365.com</a>
        ·
        <a href="https://github.com/impa365/impa-migrate" rel="noopener">GitHub</a>
        ·
        <a href="/install">/install</a>
      </div>
    </footer>
  </div>
  <script>
    const cmd = document.getElementById("install-cmd").textContent.trim();
    const btn = document.getElementById("copy-btn");
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(cmd);
        btn.textContent = "Copiado!";
        btn.classList.add("copied");
        setTimeout(() => {
          btn.textContent = "Copiar código";
          btn.classList.remove("copied");
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
      "Cache-Control": "public, max-age=300",
      "X-IMPA-Migrator": "landing",
      "X-IMPA-Version": VERSION,
    },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "Content-Type": "text/plain" } });
    }
    if (wantsScript(request, url.pathname)) {
      return serveScript();
    }
    return landingPage();
  },
};
