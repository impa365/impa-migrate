# 🚀 IMPA Migrate — Painel Web de Migração Docker Swarm & VPS

Painel web standalone para migração completa e sem perdas de ambientes Docker, Swarm, Portainer, Stacks e Volumes entre servidores VPS.

---

## ⚡ Instalação Rápida (1 comando na VPS de Origem)

```bash
curl -sSL https://migrator.impa365.com/painel | bash
```

Ou clone e suba localmente:
```bash
git clone https://github.com/impa365/impa-migrate.git /opt/impamigrate
cd /opt/impamigrate/impamigrate
bash install.sh
```

O instalador detectará o IP da sua VPS, gerará um token seguro e exibirá o link de acesso direto:
```text
http://SEU_IP:8899/?token=migrator_...
```

---

## 🧭 As 5 Etapas do Wizard de Migração

1. **Conexão SSH**:
   - Conexão e teste em tempo real com a VPS de destino (IP, porta SSH, usuário root, senha ou chave privada SSH).
   - Medição de latência e compatibilidade inicial.

2. **Raio-X da Origem & Seleção**:
   - Escaneamento automático de todas as stacks do Docker Swarm e Portainer.
   - Listagem de volumes persistentes com cálculo exato do tamanho em disco (`du -sb`).
   - Estimativa do tempo total de migração em minutos.
   - Seleção granular de quais stacks e volumes serão transferidos.

3. **Auditoria Preflight & Modo de Execução**:
   - Comparativo visual lado a lado: VPS Origem vs VPS Destino (SO, vCPU, RAM, Disco livre).
   - Validação se o disco de destino comporta todos os volumes com margem de segurança.
   - **Modo 1 · Cutover Definitivo**: A origem é pausada no final da cópia para integridade total do banco de dados antes da virada do DNS.
   - **Modo 2 · Teste / Homologação**: A origem é religada imediatamente após a transferência para continuar rodando.

4. **Monitor de Migração em Tempo Real**:
   - Barra de progresso geral com porcentagem.
   - Card em tempo real do volume atual sendo copiado, com velocidade em MB/s e tempo restante.
   - Terminal de logs com streaming de eventos e botão de abortar/cancelar seguro.

5. **Virada de Chave & Cloudflare DNS**:
   - Detecção automática de todos os domínios utilizados nas rotas do Traefik.
   - 1-clique para virar os apontamentos DNS tipo A na Cloudflare para a nova VPS.
   - **Botão de Rollback de DNS**: Restauração imediata para o IP anterior se desejar voltar atrás.

---

## 🛠️ Arquitetura Técnica

- **Backend**: FastAPI com Python 3.12, Uvicorn, Paramiko (SSH), Docker SDK, Httpx.
- **Frontend**: Single Page Application reativa (Vanilla JS, CSS Dark Theme IMPA 365, zero dependências pesadas de build).
- **Porta Padrão**: `:8899` (não conflita com SetupImpa na `:8877`).
- **Segurança**: Autenticação por token Bearer gerado na inicialização e armazenado em `/root/dados_vps/migrator_auth.json`.
