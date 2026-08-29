# IMPA Migrator

**v. 1.1.2** — one-liner interativo para migrar ambientes **Docker Swarm** (Portainer, stacks, volumes) de uma VPS para outra, sem clonar o sistema operacional.

Desenvolvido pela **IMPA 365**. Ao usar, mantenha os créditos: [impa365.com](https://impa365.com) · [github.com/impa365/impa-migrate](https://github.com/impa365/impa-migrate)

Não é obrigatório ter instalado com nenhuma ferramenta específica. Serve para **qualquer VPS com Docker Swarm** (Portainer opcional).

```bash
bash <(curl -sSL https://migrator.impa365.com)
```

No navegador, `https://migrator.impa365.com` abre a landing da IMPA (copiar comando).  
`curl` / `wget` / `/install` continuam servindo o script.

## O que faz

1. Créditos IMPA + versão no banner  
2. **Backup altamente recomendado** (confirmação em até 3 etapas)  
3. Modo **cutover** (origem fica pausada) ou **teste** (origem é religada)  
4. Discovery: OS, Swarm, stacks, volumes, `/root`, export de stacks via API do Portainer  
5. Preflight no destino (limpo, mesma arch, espaço)  
6. Provision Docker + Swarm  
7. Pausa origem → copia volumes + `/root` → sobe stacks  
8. No modo teste, religa a origem automaticamente  

## Requisitos

### Origem

| Item | Valor |
|------|--------|
| SO | Debian 11/12/13 ou Ubuntu 22.04+ |
| Ambiente | Docker **Swarm** ativo (Portainer opcional) |
| Acesso | root |
| Deps | Instaladas no início se faltarem (`curl`, `jq`, `sshpass`, `tar`, `pv`…) |

### Destino (VPS limpa)

| Item | Valor |
|------|--------|
| SO | Debian 11/12/13 ou Ubuntu 22.04+ |
| Estado | **Sem Docker** |
| Arch | Igual à origem |
| SSH | Chave ou senha (`sshpass` se senha) |

## Modos

| Modo | Origem ao final | Quando usar |
|------|-----------------|-------------|
| **1 · Cutover** | Pausada | Troca definitiva de DNS |
| **2 · Teste** | Religada | Testar a nova VPS e poder voltar o DNS |

Nos dois casos a origem **nunca é apagada**. No teste ela só fica offline o tempo da cópia dos volumes (consistência de banco).

## Backup

O wizard pergunta se você já fez backup. Se disser não, confirma mais duas vezes e só então segue **por sua conta e risco**.

## Stacks sem YAML em `/root`

O migrador exporta stacks pela **API do Portainer** (quando há credenciais) e faz `docker stack deploy` no destino. O volume `portainer_data` não é clonado (Swarm ID muda).

## DNS

1. Aponte os A records para o IP novo  
2. Teste  
3. No modo teste, pode apontar de volta para a antiga  
4. Só cancele a VPS antiga quando tiver certeza  

## Log

`/var/log/impa-migrator.log`

## Fora do escopo (por enquanto)

- Clonar o SO inteiro  
- Painel web / SaaS  
- Docker Compose sem Swarm  
- Troca de arquitetura (x86 → ARM)  
