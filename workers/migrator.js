/**
 * IMPA Migrator edge worker
 * - Browser  → landing (visual alinhado a impa365.com)
 * - curl/wget → impa-migrator.sh
 * - /install  → sempre o script
 */
// Commit fixo — evita CDN da edge servir main desatualizado por POP (ex.: GRU)
const SCRIPT_COMMIT = "f00083fd1a30471883b06b8c1ee5427ef1733381";
const SCRIPT_URL = `https://raw.githubusercontent.com/impa365/impa-migrate/${SCRIPT_COMMIT}/impa-migrator.sh`;

const VERSION = "1.1.18";
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

    @media (max-width: 800px) {
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
      <div><span class="brand-f">IMPA 365</span> · créditos ao usar o Migrator</div>
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
