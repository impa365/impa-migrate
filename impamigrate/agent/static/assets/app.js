/**
 * IMPA Migrate — Web Application Frontend.
 * Full 5-Step Server Migration Wizard with live streaming progress.
 */

(function () {
  "use strict";

  const urlParams = new URLSearchParams(window.location.search);
  const tokenFromUrl = urlParams.get("token");
  if (tokenFromUrl) {
    localStorage.setItem("impamigrate_token", tokenFromUrl);
  }

  const state = {
    token: localStorage.getItem("impamigrate_token") || "",
    currentStep: 1, // 1: Conexão, 2: Raio-X & Stacks, 3: Preflight, 4: Migração Live, 5: Cloudflare DNS
    loading: false,
    originSystem: null,
    discovery: null,
    portainerCreds: { user: "admin", password: "" },

    dest: {
      host: "",
      port: 22,
      username: "root",
      authMode: "password", // password | key
      password: "",
      privateKey: "",
    },

    sshTested: false,
    sshResult: null,

    selectedStacks: new Set(),
    selectedVolumes: new Set(),

    preflightLoading: false,
    preflightResult: null,

    migrationConfig: {
      mode: "cutover", // cutover | test
      rateLimitMb: 0,
    },

    job: null,
    jobPollTimer: null,

    cfToken: "",
    cfStatus: null,
    cfDomains: [],
    cfCutoverResult: null,
    cfRollbackResult: null,
  };

  // ── Helper: API Client ──────────────────────────────────────────
  async function api(path, options = {}) {
    const headers = options.headers || {};
    if (state.token) {
      headers["Authorization"] = `Bearer ${state.token}`;
      headers["X-Migrator-Token"] = state.token;
    }
    if (options.body && typeof options.body === "object" && !(options.body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(options.body);
    }
    const res = await fetch(path, { ...options, headers });
    if (res.status === 401) {
      toast("Sessão ou token inválido.", "err");
      throw new Error("401 Unauthorized");
    }
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || data.error || `Erro HTTP ${res.status}`);
    }
    return data;
  }

  function toast(message, type = "info") {
    const container = document.getElementById("toast-container");
    if (!container) return;
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 250);
    }, 4000);
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // ── Init & LifeCycle ────────────────────────────────────────────
  async function init() {
    try {
      const authData = await api("/api/auth/status");
      if (authData.token && !state.token) {
        state.token = authData.token;
        localStorage.setItem("impamigrate_token", state.token);
      }
    } catch (_) {}

    try {
      const originSys = await api("/api/origin/system");
      state.originSystem = originSys;
    } catch (e) {
      logErr("Falha ao carregar sistema local: " + e.message);
    }

    // Check if migration is already running
    try {
      const jobStatus = await api("/api/migration/status");
      if (jobStatus.status === "running") {
        state.job = jobStatus;
        state.currentStep = 4;
        startJobPolling();
      }
    } catch (_) {}

    render();
  }

  function logErr(msg) {
    console.error(msg);
  }

  // ── Polling Job Status ──────────────────────────────────────────
  function startJobPolling() {
    if (state.jobPollTimer) clearInterval(state.jobPollTimer);
    state.jobPollTimer = setInterval(async () => {
      try {
        const res = await api("/api/migration/status");
        state.job = res;
        render();

        // Auto-scroll terminal log
        const term = document.getElementById("terminal-body");
        if (term) term.scrollTop = term.scrollHeight;

        if (res.status === "completed" || res.status === "failed" || res.status === "cancelled") {
          clearInterval(state.jobPollTimer);
          state.jobPollTimer = null;
          if (res.status === "completed") {
            toast("🎉 Migração concluída com sucesso!", "ok");
            state.currentStep = 5;
            loadCloudflareInfo();
            render();
          } else {
            toast(`Migração ${res.status}: ${res.error || "Verifique os logs"}`, "err");
          }
        }
      } catch (e) {
        console.error("Polling error:", e);
      }
    }, 1500);
  }

  async function loadCloudflareInfo() {
    try {
      const st = await api("/api/cloudflare/status");
      state.cfStatus = st;
      if (state.discovery?.stacks) {
        const doms = await api("/api/cloudflare/detect-domains", {
          method: "POST",
          body: state.discovery.stacks,
        });
        state.cfDomains = doms.domains || [];
      }
    } catch (_) {}
  }

  // ── Render Views ────────────────────────────────────────────────
  function render() {
    const root = document.getElementById("app");
    if (!root) return;

    const pubIp = state.originSystem?.public_ip || "Detectando...";
    const swarmRole = state.originSystem?.docker?.swarm_role || "inactive";

    root.innerHTML = `
      <header class="top-header">
        <div class="brand-wrap">
          <span class="brand-badge">IMPA 365</span>
          <span class="brand-title">IMPA Migrate</span>
        </div>
        <div class="header-status-box">
          <div class="status-badge">
            <span class="status-dot"></span>
            <span>Origem: <strong>${escapeHtml(pubIp)}</strong></span>
          </div>
          <div class="status-badge" style="background: rgba(6, 182, 212, 0.08); border-color: rgba(6, 182, 212, 0.3); color: #38bdf8;">
            <span>Swarm: <strong>${escapeHtml(swarmRole.toUpperCase())}</strong></span>
          </div>
        </div>
      </header>

      <nav class="stepper-nav">
        <div class="step-item ${state.currentStep === 1 ? "active" : state.currentStep > 1 ? "completed" : ""}" data-go-step="1">
          <div class="step-num">${state.currentStep > 1 ? "✓" : "1"}</div>
          <div class="step-text">Conexão SSH</div>
        </div>
        <div class="step-divider"></div>

        <div class="step-item ${state.currentStep === 2 ? "active" : state.currentStep > 2 ? "completed" : ""}" data-go-step="2">
          <div class="step-num">${state.currentStep > 2 ? "✓" : "2"}</div>
          <div class="step-text">Raio-X & Stacks</div>
        </div>
        <div class="step-divider"></div>

        <div class="step-item ${state.currentStep === 3 ? "active" : state.currentStep > 3 ? "completed" : ""}" data-go-step="3">
          <div class="step-num">${state.currentStep > 3 ? "✓" : "3"}</div>
          <div class="step-text">Preflight & Modo</div>
        </div>
        <div class="step-divider"></div>

        <div class="step-item ${state.currentStep === 4 ? "active" : state.currentStep > 4 ? "completed" : ""}" data-go-step="4">
          <div class="step-num">${state.currentStep > 4 ? "✓" : "4"}</div>
          <div class="step-text">Migração Live</div>
        </div>
        <div class="step-divider"></div>

        <div class="step-item ${state.currentStep === 5 ? "active" : ""}" data-go-step="5">
          <div class="step-num">5</div>
          <div class="step-text">Virada de DNS (Cloudflare)</div>
        </div>
      </nav>

      <main class="main-container">
        ${state.currentStep === 1 ? renderStep1() : ""}
        ${state.currentStep === 2 ? renderStep2() : ""}
        ${state.currentStep === 3 ? renderStep3() : ""}
        ${state.currentStep === 4 ? renderStep4() : ""}
        ${state.currentStep === 5 ? renderStep5() : ""}
      </main>
    `;

    bindEvents();
  }

  // ── Step 1: Conexão Destino ─────────────────────────────────────
  function renderStep1() {
    return `
      <div class="step-card">
        <div class="step-header">
          <h2>Etapa 1 · Conexão com a VPS de Destino</h2>
          <p>Informe o endereço IP e as credenciais de acesso root da sua VPS limpa onde o ambiente será recriado.</p>
        </div>

        <div class="form-grid">
          <div class="form-group">
            <label class="form-label">Endereço IP da VPS Destino (Nova)</label>
            <input type="text" class="form-input" id="input-dest-host" placeholder="Ex: 147.93.20.10" value="${escapeHtml(state.dest.host)}" />
            <span class="form-hint">A VPS que receberá os containers e volumes da migração.</span>
          </div>

          <div class="form-group">
            <label class="form-label">Porta SSH</label>
            <input type="number" class="form-input" id="input-dest-port" value="${state.dest.port || 22}" />
            <span class="form-hint">Padrão: 22.</span>
          </div>

          <div class="form-group">
            <label class="form-label">Usuário de Acesso</label>
            <input type="text" class="form-input" id="input-dest-user" value="${escapeHtml(state.dest.username || "root")}" />
            <span class="form-hint">Obrigatório ser root para criação de volumes e configuração do Docker.</span>
          </div>

          <div class="form-group">
            <label class="form-label">Método de Autenticação</label>
            <div style="display: flex; gap: 0.75rem; margin-top: 0.35rem;">
              <label style="display: flex; align-items: center; gap: 0.4rem; cursor: pointer; font-size: 0.88rem;">
                <input type="radio" name="auth-mode" value="password" ${state.dest.authMode === "password" ? "checked" : ""} />
                Senha do Root
              </label>
              <label style="display: flex; align-items: center; gap: 0.4rem; cursor: pointer; font-size: 0.88rem;">
                <input type="radio" name="auth-mode" value="key" ${state.dest.authMode === "key" ? "checked" : ""} />
                Chave Privada SSH
              </label>
            </div>
          </div>

          ${state.dest.authMode === "password" ? `
            <div class="form-group full">
              <label class="form-label">Senha Root do Destino</label>
              <input type="password" class="form-input" id="input-dest-password" placeholder="Digite a senha da nova VPS" value="${escapeHtml(state.dest.password)}" />
            </div>
          ` : `
            <div class="form-group full">
              <label class="form-label">Chave Privada SSH (OpenSSH / RSA / Ed25519)</label>
              <textarea class="form-input" id="input-dest-key" rows="4" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----...">${escapeHtml(state.dest.privateKey)}</textarea>
            </div>
          `}
        </div>

        ${state.sshResult ? `
          <div style="margin-top: 1.5rem; padding: 1rem 1.25rem; border-radius: var(--radius-sm); border: 1px solid ${state.sshResult.ok ? "rgba(16, 185, 129, 0.4)" : "rgba(239, 68, 68, 0.4)"}; background: ${state.sshResult.ok ? "rgba(16, 185, 129, 0.08)" : "rgba(239, 68, 68, 0.08)"}; font-size: 0.88rem;">
            ${state.sshResult.ok ? `
              <strong style="color: #34d399;">✔ ${escapeHtml(state.sshResult.message)}</strong>
              <div style="margin-top: 0.35rem; color: var(--text-muted); font-size: 0.82rem;">Latência: ${state.sshResult.latency_ms}ms · Resposta do host: <code>${escapeHtml(state.sshResult.details)}</code></div>
            ` : `
              <strong style="color: #f87171;">✗ Falha de Conexão:</strong>
              <div style="margin-top: 0.35rem; color: #fca5a5;">${escapeHtml(state.sshResult.error)}</div>
            `}
          </div>
        ` : ""}

        <div class="actions-row">
          <button class="btn-secondary" id="btn-test-ssh" ${state.loading ? "disabled" : ""}>
            ${state.loading ? "Testando Conexão..." : "⚡ Testar Conexão SSH"}
          </button>
          <button class="btn-primary" id="btn-goto-step-2" ${!state.sshResult?.ok ? "disabled" : ""}>
            Avançar para Raio-X & Stacks ➜
          </button>
        </div>
      </div>
    `;
  }

  // ── Step 2: Raio-X & Stacks ─────────────────────────────────────
  function renderStep2() {
    const disc = state.discovery;
    if (!disc) {
      return `
        <div class="step-card" style="text-align: center; padding: 4rem 2rem;">
          <div class="spinner" style="margin: 0 auto 1.5rem;"></div>
          <h3>Escaneando ambiente da VPS de Origem...</h3>
          <p style="color: var(--text-muted); margin-top: 0.5rem;">Auditando containers, Portainer, volumes e arquivos de configuração.</p>
        </div>
      `;
    }

    const totals = disc.totals || {};
    const stacks = disc.stacks || [];
    const volumes = disc.volumes || [];

    return `
      <div class="step-card">
        <div class="step-header">
          <h2>Etapa 2 · Raio-X da Origem & Seleção</h2>
          <p>Selecione as stacks e volumes que deseja migrar. O migrador garante a integridade de dados e bancos.</p>
        </div>

        <div class="stats-summary-grid">
          <div class="summary-card">
            <div class="summary-icon">📦</div>
            <div>
              <div class="summary-val">${stacks.length}</div>
              <div class="summary-label">Stacks Detectadas</div>
            </div>
          </div>
          <div class="summary-card">
            <div class="summary-icon">💾</div>
            <div>
              <div class="summary-val">${volumes.length}</div>
              <div class="summary-label">Volumes Docker</div>
            </div>
          </div>
          <div class="summary-card">
            <div class="summary-icon">⚡</div>
            <div>
              <div class="summary-val">${escapeHtml(totals.total_human || "0 GB")}</div>
              <div class="summary-label">Tamanho Total</div>
            </div>
          </div>
          <div class="summary-card">
            <div class="summary-icon">⏱️</div>
            <div>
              <div class="summary-val">~${totals.estimated_minutes || 2} min</div>
              <div class="summary-label">Tempo Estimado</div>
            </div>
          </div>
        </div>

        <!-- Stacks List -->
        <div class="items-list-card">
          <div class="list-header">
            <div class="list-title">
              <span>📦</span> Stacks de Aplicativos para Migração
            </div>
            <div style="font-size: 0.8rem; color: var(--text-dim);">
              <label style="cursor: pointer; display: flex; align-items: center; gap: 0.4rem;">
                <input type="checkbox" id="select-all-stacks" ${state.selectedStacks.size === stacks.length ? "checked" : ""} />
                Marcar Todas
              </label>
            </div>
          </div>
          <div>
            ${stacks.map(s => {
              const checked = state.selectedStacks.has(s.name);
              return `
                <div class="list-item">
                  <div class="item-left">
                    <input type="checkbox" class="stack-checkbox" data-stack-name="${escapeHtml(s.name)}" ${checked ? "checked" : ""} />
                    <div>
                      <strong style="font-size: 0.95rem;">${escapeHtml(s.name)}</strong>
                      <div style="font-size: 0.8rem; color: var(--text-dim); margin-top: 0.15rem;">
                        ${s.services_count ? `${s.services_count} serviço(s)` : s.type}
                      </div>
                    </div>
                  </div>
                  <div>
                    <span class="badge-pill ${s.is_system ? "purple" : s.active ? "green" : "cyan"}">
                      ${s.is_system ? "Sistema Base" : s.active ? "Ativa" : "Parada"}
                    </span>
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        </div>

        <!-- Volumes List -->
        <div class="items-list-card">
          <div class="list-header">
            <div class="list-title">
              <span>💾</span> Volumes Persistentes de Dados
            </div>
            <div style="font-size: 0.8rem; color: var(--text-dim);">
              <label style="cursor: pointer; display: flex; align-items: center; gap: 0.4rem;">
                <input type="checkbox" id="select-all-volumes" ${state.selectedVolumes.size === volumes.length ? "checked" : ""} />
                Marcar Todos
              </label>
            </div>
          </div>
          <div style="max-height: 260px; overflow-y: auto;">
            ${volumes.map(v => {
              const checked = state.selectedVolumes.has(v.name);
              return `
                <div class="list-item">
                  <div class="item-left">
                    <input type="checkbox" class="vol-checkbox" data-vol-name="${escapeHtml(v.name)}" ${checked ? "checked" : ""} />
                    <div>
                      <strong style="font-size: 0.88rem; font-family: monospace;">${escapeHtml(v.name)}</strong>
                      <div style="font-size: 0.78rem; color: var(--text-dim);">
                        ${v.containers?.length ? `Vinculado a: ${v.containers.join(", ")}` : "Volume Docker"}
                      </div>
                    </div>
                  </div>
                  <div style="text-align: right;">
                    <strong style="font-size: 0.88rem; color: #38bdf8;">${escapeHtml(v.size_human)}</strong>
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        </div>

        <div class="actions-row">
          <button class="btn-secondary" onclick="window.__changeStep(1)">
            ⬅ Voltar (Conexão)
          </button>
          <button class="btn-primary" id="btn-goto-step-3">
            Avançar para Preflight & Auditoria ➜
          </button>
        </div>
      </div>
    `;
  }

  // ── Step 3: Preflight & Comparativo ─────────────────────────────
  function renderStep3() {
    const pf = state.preflightResult;
    const orig = state.originSystem;
    const dest = pf?.destination;

    return `
      <div class="step-card">
        <div class="step-header">
          <h2>Etapa 3 · Auditoria Preflight & Modo de Migração</h2>
          <p>Comparação técnica entre os dois servidores e escolha do comportamento de corte.</p>
        </div>

        <div class="comparison-grid">
          <div class="comp-column">
            <div class="comp-header">
              <strong style="color: #38bdf8; font-size: 1rem;">VPS Origem (Atual)</strong>
              <span class="badge-pill cyan">ORIGEM</span>
            </div>
            <div class="comp-item">
              <span style="color: var(--text-dim);">IP:</span>
              <strong>${escapeHtml(orig?.public_ip || "—")}</strong>
            </div>
            <div class="comp-item">
              <span style="color: var(--text-dim);">Sistema Operacional:</span>
              <strong>${escapeHtml(orig?.os_name || "—")}</strong>
            </div>
            <div class="comp-item">
              <span style="color: var(--text-dim);">Arquitetura:</span>
              <strong>${escapeHtml(orig?.arch || "—")}</strong>
            </div>
            <div class="comp-item">
              <span style="color: var(--text-dim);">CPU Cores:</span>
              <strong>${orig?.metrics?.cpu_cores || 1} vCPU</strong>
            </div>
            <div class="comp-item">
              <span style="color: var(--text-dim);">RAM Livre / Total:</span>
              <strong>${orig?.metrics?.ram_free_mb || 0} MB / ${orig?.metrics?.ram_total_mb || 0} MB</strong>
            </div>
            <div class="comp-item">
              <span style="color: var(--text-dim);">Disco Utilizado:</span>
              <strong>${orig?.metrics?.disk_used_gb || 0} GB (${orig?.metrics?.disk_percent || 0}%)</strong>
            </div>
          </div>

          <div class="comp-column">
            <div class="comp-header">
              <strong style="color: #34d399; font-size: 1rem;">VPS Destino (Nova)</strong>
              <span class="badge-pill green">DESTINO</span>
            </div>
            <div class="comp-item">
              <span style="color: var(--text-dim);">IP:</span>
              <strong>${escapeHtml(dest?.host || state.dest.host)}</strong>
            </div>
            <div class="comp-item">
              <span style="color: var(--text-dim);">Sistema Operacional:</span>
              <strong>${escapeHtml(dest?.os_name || "Auditando...")}</strong>
            </div>
            <div class="comp-item">
              <span style="color: var(--text-dim);">Arquitetura:</span>
              <strong>${escapeHtml(dest?.arch || "Auditando...")}</strong>
            </div>
            <div class="comp-item">
              <span style="color: var(--text-dim);">Disco Livre:</span>
              <strong style="color: #34d399;">${dest?.disk_free_gb ? dest.disk_free_gb + " GB livres" : "—"}</strong>
            </div>
            <div class="comp-item">
              <span style="color: var(--text-dim);">Docker no Destino:</span>
              <strong>${dest?.has_docker ? "Instalado" : "Será instalado automaticamente"}</strong>
            </div>
            <div class="comp-item">
              <span style="color: var(--text-dim);">Ambiente Limpo:</span>
              <strong>${dest?.running_containers === 0 ? "✔ 100% Limpo" : "⚠️ " + dest?.running_containers + " container(s) ativos"}</strong>
            </div>
          </div>
        </div>

        <!-- Mode selection -->
        <div style="background: rgba(0, 0, 0, 0.25); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 1.25rem; margin-bottom: 1.75rem;">
          <h4 style="margin-bottom: 0.75rem; font-size: 0.95rem;">Modo de Execução da Migração:</h4>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
            <label style="border: 1px solid ${state.migrationConfig.mode === "cutover" ? "#06b6d4" : "var(--border)"}; background: ${state.migrationConfig.mode === "cutover" ? "rgba(6, 182, 212, 0.1)" : "rgba(255,255,255,0.02)"}; border-radius: var(--radius-sm); padding: 1rem; cursor: pointer;">
              <div style="display: flex; align-items: center; gap: 0.5rem; font-weight: 700; margin-bottom: 0.35rem;">
                <input type="radio" name="mig-mode" value="cutover" ${state.migrationConfig.mode === "cutover" ? "checked" : ""} />
                Modo 1 · Cutover Definitivo (Recomendado)
              </div>
              <p style="font-size: 0.8rem; color: var(--text-muted); line-height: 1.4;">
                A VPS de origem é pausada no final da cópia para garantir que nenhum cliente grave dados no banco antigo antes da virada do DNS. <em>A origem nunca é apagada.</em>
              </p>
            </label>

            <label style="border: 1px solid ${state.migrationConfig.mode === "test" ? "#10b981" : "var(--border)"}; background: ${state.migrationConfig.mode === "test" ? "rgba(16, 185, 129, 0.1)" : "rgba(255,255,255,0.02)"}; border-radius: var(--radius-sm); padding: 1rem; cursor: pointer;">
              <div style="display: flex; align-items: center; gap: 0.5rem; font-weight: 700; margin-bottom: 0.35rem;">
                <input type="radio" name="mig-mode" value="test" ${state.migrationConfig.mode === "test" ? "checked" : ""} />
                Modo 2 · Teste com Origem Religada
              </div>
              <p style="font-size: 0.8rem; color: var(--text-muted); line-height: 1.4;">
                Após a transferência dos dados, a VPS de origem é religada imediatamente para continuar atendendo normalmente enquanto você valida o novo servidor.
              </p>
            </label>
          </div>
        </div>

        <div class="actions-row">
          <button class="btn-secondary" onclick="window.__changeStep(2)">
            ⬅ Voltar (Seleção)
          </button>
          <button class="btn-primary" id="btn-start-migration">
            🚀 Iniciar Migração Automatizada Agora
          </button>
        </div>
      </div>
    `;
  }

  // ── Step 4: Migração Live Monitor ───────────────────────────────
  function renderStep4() {
    const job = state.job || {};
    const percent = job.overall_percent || 0;
    const vol = job.current_volume || {};
    const logs = job.logs || [];

    return `
      <div class="step-card">
        <div class="step-header">
          <h2>Etapa 4 · Monitor de Migração em Tempo Real</h2>
          <p>O migrador está operando em segundo plano. Você pode acompanhar cada etapa com telemetria detalhada.</p>
        </div>

        <div class="progress-banner">
          <div class="progress-header">
            <div>
              <strong style="font-size: 1.1rem; color: #ffffff;">${escapeHtml(job.current_step_label || "Executando migração...")}</strong>
              <div style="font-size: 0.82rem; color: var(--text-muted); margin-top: 0.2rem;">
                Etapa ${job.step_index || 1} de ${job.total_steps || 8} · Modo: <strong>${escapeHtml((job.mode || "cutover").toUpperCase())}</strong> · Tempo decorrido: ${job.elapsed_seconds || 0}s
              </div>
            </div>
            <div style="font-size: 1.7rem; font-weight: 800; color: #38bdf8;">
              ${Math.round(percent)}%
            </div>
          </div>

          <div class="progress-bar-bg">
            <div class="progress-bar-fill" style="width: ${percent}%;"></div>
          </div>
        </div>

        ${vol.name ? `
          <div class="volume-live-card">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
              <div>
                <span style="font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-dim);">Transferindo Volume:</span>
                <strong style="display: block; font-family: monospace; font-size: 0.95rem; color: #38bdf8;">${escapeHtml(vol.name)}</strong>
              </div>
              <div style="text-align: right;">
                <span style="font-size: 0.85rem; font-weight: 700; color: #34d399;">${vol.speed_mbps || 0} MB/s</span>
              </div>
            </div>
            <div class="progress-bar-bg" style="height: 6px;">
              <div class="progress-bar-fill" style="width: ${vol.percent || 0}%; background: #10b981;"></div>
            </div>
          </div>
        ` : ""}

        <!-- Terminal Logs -->
        <div class="terminal-window">
          <div class="terminal-header">
            <span>Terminal de Auditoria da Migração (Live Stream)</span>
            <span>${logs.length} eventos registrados</span>
          </div>
          <div class="terminal-body" id="terminal-body">
            ${logs.map(l => `
              <div class="log-line">
                <span class="log-time">[${escapeHtml(l.time_str || "")}]</span>
                <span class="log-${escapeHtml(l.level)}">${escapeHtml(l.message)}</span>
              </div>
            `).join("")}
          </div>
        </div>

        <div class="actions-row">
          <button class="btn-danger" id="btn-cancel-migration" ${job.status !== "running" ? "disabled" : ""}>
            🛑 Abortar Migração
          </button>
          ${job.status === "completed" ? `
            <button class="btn-primary" onclick="window.__changeStep(5)">
              Avançar para Virada de DNS (Cloudflare) ➜
            </button>
          ` : ""}
        </div>
      </div>
    `;
  }

  // ── Step 5: Virada de DNS (Cloudflare) ───────────────────────────
  function renderStep5() {
    const cf = state.cfStatus;
    const domains = state.cfDomains || [];
    const destIp = state.dest.host;

    return `
      <div class="step-card">
        <div class="step-header">
          <h2>Etapa 5 · Virada de Chave & Automação de DNS (Cloudflare)</h2>
          <p>Sua nova VPS já está com todas as stacks e volumes rodando. Agora você pode apontar seus domínios com 1 clique.</p>
        </div>

        <!-- Token config -->
        <div style="background: var(--bg-card-sub); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 1.25rem; margin-bottom: 1.5rem;">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem; margin-bottom: 1rem;">
            <div>
              <strong style="font-size: 0.95rem;">Token da API Cloudflare</strong>
              <div style="font-size: 0.8rem; color: var(--text-dim);">Permissão obrigatória: Zone:DNS:Edit e Zone:Zone:Read</div>
            </div>
            <div>
              <span class="badge-pill ${cf?.configured ? "green" : "purple"}">
                ${cf?.configured ? "● Conectado à Cloudflare" : "○ Não configurado"}
              </span>
            </div>
          </div>

          <div style="display: flex; gap: 0.5rem;">
            <input type="password" class="form-input" id="input-cf-token" style="flex: 1;" placeholder="Cole seu Cloudflare API Token" value="${escapeHtml(state.cfToken)}" />
            <button class="btn-secondary" id="btn-save-cf-token">Salvar Token</button>
          </div>
        </div>

        <!-- Domains to switch -->
        <div class="items-list-card">
          <div class="list-header">
            <div class="list-title">
              <span>🌐</span> Domínios Identificados nas Stacks Migradas
            </div>
            <span style="font-size: 0.8rem; color: var(--text-dim);">${domains.length} domínio(s)</span>
          </div>
          <div>
            ${domains.length === 0 ? `
              <div style="padding: 2rem; text-align: center; color: var(--text-muted); font-size: 0.88rem;">
                Nenhum domínio com regra Traefik explícita detectado automaticamente. Você pode apontar manualmente para o IP <code>${escapeHtml(destIp)}</code>.
              </div>
            ` : domains.map(d => `
              <div class="list-item">
                <div class="item-left">
                  <span>🔗</span>
                  <strong style="font-family: monospace; font-size: 0.92rem;">${escapeHtml(d)}</strong>
                </div>
                <div>
                  <span style="font-size: 0.82rem; color: var(--text-muted);">Apontará para: <strong>${escapeHtml(destIp)}</strong></span>
                </div>
              </div>
            `).join("")}
          </div>
        </div>

        ${state.cfCutoverResult ? `
          <div style="margin-top: 1rem; padding: 1rem; border-radius: var(--radius-sm); background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); font-size: 0.88rem; color: #34d399;">
            ✔ <strong>Virada de Chave Realizada com Sucesso!</strong> Os apontamentos DNS foram atualizados para a nova VPS. O snapshot de segurança foi salvo.
          </div>
        ` : ""}

        <div class="actions-row">
          <button class="btn-secondary" id="btn-rollback-dns">
            ⏪ Desfazer Virada (Rollback de DNS)
          </button>
          <button class="btn-primary" id="btn-execute-cutover" ${domains.length === 0 || !cf?.configured ? "disabled" : ""}>
            🚀 Virar Apontamentos DNS na Cloudflare Agora
          </button>
        </div>
      </div>
    `;
  }

  // ── Global Step Change ──────────────────────────────────────────
  window.__changeStep = (target) => {
    state.currentStep = target;
    render();
  };

  // ── Bind DOM Events ─────────────────────────────────────────────
  function bindEvents() {
    // Stepper navigation click
    document.querySelectorAll("[data-go-step]").forEach(el => {
      el.onclick = () => {
        const target = parseInt(el.dataset.goStep, 10);
        // Only allow jumping back or to completed steps
        if (target <= state.currentStep || (state.job?.status === "completed" && target === 5)) {
          state.currentStep = target;
          render();
        }
      };
    });

    // Step 1 Events
    const hostInput = document.getElementById("input-dest-host");
    if (hostInput) hostInput.oninput = (e) => state.dest.host = e.target.value.trim();

    const portInput = document.getElementById("input-dest-port");
    if (portInput) portInput.oninput = (e) => state.dest.port = parseInt(e.target.value, 10) || 22;

    const userInput = document.getElementById("input-dest-user");
    if (userInput) userInput.oninput = (e) => state.dest.username = e.target.value.trim();

    const passInput = document.getElementById("input-dest-password");
    if (passInput) passInput.oninput = (e) => state.dest.password = e.target.value;

    const keyInput = document.getElementById("input-dest-key");
    if (keyInput) keyInput.oninput = (e) => state.dest.privateKey = e.target.value;

    document.querySelectorAll("input[name='auth-mode']").forEach(r => {
      r.onchange = (e) => {
        state.dest.authMode = e.target.value;
        render();
      };
    });

    const btnTestSsh = document.getElementById("btn-test-ssh");
    if (btnTestSsh) {
      btnTestSsh.onclick = async () => {
        if (!state.dest.host) {
          toast("Preencha o IP da VPS de destino", "err");
          return;
        }
        state.loading = true;
        render();
        try {
          const res = await api("/api/destination/test-ssh", {
            method: "POST",
            body: {
              host: state.dest.host,
              port: state.dest.port,
              username: state.dest.username,
              password: state.dest.authMode === "password" ? state.dest.password : null,
              private_key: state.dest.authMode === "key" ? state.dest.privateKey : null,
            },
          });
          state.sshResult = res;
          toast("SSH autenticado com sucesso!", "ok");
        } catch (e) {
          state.sshResult = { ok: false, error: e.message };
          toast("Falha no teste SSH: " + e.message, "err");
        } finally {
          state.loading = false;
          render();
        }
      };
    }

    const btnGotoStep2 = document.getElementById("btn-goto-step-2");
    if (btnGotoStep2) {
      btnGotoStep2.onclick = async () => {
        state.currentStep = 2;
        render();
        if (!state.discovery) {
          try {
            const disc = await api("/api/origin/scan", { method: "POST" });
            state.discovery = disc;
            // Select all active stacks by default
            (disc.stacks || []).forEach(s => {
              if (s.active && !s.is_system) state.selectedStacks.add(s.name);
            });
            // Select all volumes by default
            (disc.volumes || []).forEach(v => state.selectedVolumes.add(v.name));
            render();
          } catch (e) {
            toast("Erro no scan de origem: " + e.message, "err");
          }
        }
      };
    }

    // Step 2 Events
    const checkAllStacks = document.getElementById("select-all-stacks");
    if (checkAllStacks) {
      checkAllStacks.onchange = (e) => {
        if (e.target.checked) {
          (state.discovery?.stacks || []).forEach(s => state.selectedStacks.add(s.name));
        } else {
          state.selectedStacks.clear();
        }
        render();
      };
    }

    document.querySelectorAll(".stack-checkbox").forEach(cb => {
      cb.onchange = (e) => {
        const sName = cb.dataset.stackName;
        if (e.target.checked) state.selectedStacks.add(sName);
        else state.selectedStacks.delete(sName);
      };
    });

    const checkAllVols = document.getElementById("select-all-volumes");
    if (checkAllVols) {
      checkAllVols.onchange = (e) => {
        if (e.target.checked) {
          (state.discovery?.volumes || []).forEach(v => state.selectedVolumes.add(v.name));
        } else {
          state.selectedVolumes.clear();
        }
        render();
      };
    }

    document.querySelectorAll(".vol-checkbox").forEach(cb => {
      cb.onchange = (e) => {
        const vName = cb.dataset.volName;
        if (e.target.checked) state.selectedVolumes.add(vName);
        else state.selectedVolumes.delete(vName);
      };
    });

    const btnGotoStep3 = document.getElementById("btn-goto-step-3");
    if (btnGotoStep3) {
      btnGotoStep3.onclick = async () => {
        state.currentStep = 3;
        render();
        // Trigger Preflight
        try {
          const reqBytes = state.discovery?.totals?.total_bytes || 0;
          const pf = await api("/api/destination/preflight", {
            method: "POST",
            body: {
              host: state.dest.host,
              port: state.dest.port,
              username: state.dest.username,
              password: state.dest.authMode === "password" ? state.dest.password : null,
              private_key: state.dest.authMode === "key" ? state.dest.privateKey : null,
              origin_arch: state.originSystem?.arch || "x86_64",
              required_bytes: reqBytes,
            },
          });
          state.preflightResult = pf;
          render();
        } catch (e) {
          toast("Falha na auditoria de preflight: " + e.message, "err");
        }
      };
    }

    // Step 3 Events
    document.querySelectorAll("input[name='mig-mode']").forEach(r => {
      r.onchange = (e) => {
        state.migrationConfig.mode = e.target.value;
        render();
      };
    });

    const btnStartMigration = document.getElementById("btn-start-migration");
    if (btnStartMigration) {
      btnStartMigration.onclick = async () => {
        if (!confirm("Confirmar início da migração para a nova VPS?")) return;
        state.currentStep = 4;
        render();
        try {
          const plan = {
            dest_ip: state.dest.host,
            dest_port: state.dest.port,
            dest_user: state.dest.username,
            dest_password: state.dest.authMode === "password" ? state.dest.password : null,
            dest_private_key: state.dest.authMode === "key" ? state.dest.privateKey : null,
            selected_stacks: Array.from(state.selectedStacks),
            selected_volumes: Array.from(state.selectedVolumes),
            mode: state.migrationConfig.mode,
            rate_limit_mb: state.migrationConfig.rateLimitMb,
          };
          const res = await api("/api/migration/start", {
            method: "POST",
            body: plan,
          });
          toast("Job de migração iniciado com sucesso!", "ok");
          startJobPolling();
        } catch (e) {
          toast("Erro ao iniciar: " + e.message, "err");
        }
      };
    }

    // Step 4 Events
    const btnCancelMig = document.getElementById("btn-cancel-migration");
    if (btnCancelMig) {
      btnCancelMig.onclick = async () => {
        if (!confirm("Deseja realmente abortar a migração em andamento?")) return;
        try {
          await api("/api/migration/cancel", { method: "POST" });
          toast("Cancelamento solicitado!", "warn");
        } catch (e) {
          toast("Erro ao cancelar: " + e.message, "err");
        }
      };
    }

    // Step 5 Events
    const cfTokenInput = document.getElementById("input-cf-token");
    if (cfTokenInput) cfTokenInput.oninput = (e) => state.cfToken = e.target.value.trim();

    const btnSaveCf = document.getElementById("btn-save-cf-token");
    if (btnSaveCf) {
      btnSaveCf.onclick = async () => {
        if (!state.cfToken) return;
        try {
          await api("/api/cloudflare/token", {
            method: "POST",
            body: { token: state.cfToken },
          });
          toast("Token Cloudflare salvo com sucesso!", "ok");
          await loadCloudflareInfo();
          render();
        } catch (e) {
          toast("Erro: " + e.message, "err");
        }
      };
    }

    const btnCutover = document.getElementById("btn-execute-cutover");
    if (btnCutover) {
      btnCutover.onclick = async () => {
        if (!confirm(`Confirma a alteração do DNS dos ${state.cfDomains.length} domínios para o IP ${state.dest.host}?`)) return;
        try {
          const res = await api("/api/cloudflare/cutover", {
            method: "POST",
            body: {
              domains: state.cfDomains,
              dest_ip: state.dest.host,
            },
          });
          state.cfCutoverResult = res;
          toast("Apontamentos DNS atualizados com sucesso!", "ok");
          render();
        } catch (e) {
          toast("Erro no cutover de DNS: " + e.message, "err");
        }
      };
    }

    const btnRollback = document.getElementById("btn-rollback-dns");
    if (btnRollback) {
      btnRollback.onclick = async () => {
        if (!confirm("Deseja reverter os apontamentos DNS para o IP da VPS de origem?")) return;
        try {
          const res = await api("/api/cloudflare/rollback", { method: "POST" });
          state.cfRollbackResult = res;
          toast(res.message || "Rollback concluído!", "ok");
        } catch (e) {
          toast("Erro no rollback: " + e.message, "err");
        }
      };
    }
  }

  // Run on load
  document.addEventListener("DOMContentLoaded", init);
})();
