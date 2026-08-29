# IMPA Migrator

One-liner interativo para migrar ambientes **SetupOrion** (Docker Swarm + Traefik + Portainer + stacks + volumes) de uma VPS para outra — sem clonar o sistema operacional.

Estilo SetupOrion: Bash puro, wizard no terminal, zero painel/SaaS.

```bash
sudo ./impa-migrator.sh
```

One-liner futuro (quando hospedado):

```bash
bash <(curl -sSL migrator.impa365.com)
```

## O que este migrador faz

Roda na **VPS de origem** e:

1. Detecta SO, arquitetura, Swarm, stacks, redes overlay, volumes e YAMLs em `/root`
2. Conecta na VPS nova via SSH e valida que está limpa
3. Instala Docker + inicia Swarm no destino
4. Recria redes overlay e volumes com os mesmos nomes
5. Pausa as stacks na origem (consistência de Postgres/dados)
6. Transfere volumes (`_data`), YAMLs e `/root/dados_vps`
7. Faz `docker stack deploy` (Traefik → Portainer → demais)
8. Tenta recriar o admin do Portainer (Swarm ID muda; não reutiliza stacks órfãs do volume antigo)
9. Gera relatório + instrução de DNS

A origem **não é apagada** — só fica com replicas em 0.

## Requisitos

### Origem

| Item | Valor |
|------|--------|
| SO | Debian 11/12/13 ou Ubuntu 22.04+ |
| Ambiente | Docker Swarm ativo (SetupOrion) |
| Acesso | root |
| Artefatos | `/root/*.yaml` e idealmente `/root/dados_vps/` |

### Destino (obrigatório: VPS limpa)

| Item | Valor |
|------|--------|
| SO | Debian 11/12/13 ou Ubuntu 22.04+ |
| Estado | **Sem Docker**, sem containers |
| Arch | **Igual** à origem (`x86_64` ↔ `x86_64`) |
| Espaço | Dados da origem + margem (~15% + 5 GB) |
| SSH | Chave ou senha (`sshpass` se senha) |

> **Greenfield:** se o destino já tiver Docker, o script **aborta**. Isso corta 90% do suporte.

## Fluxo (wizard)

```
Banner + aceite (Y/N)
        ↓
Discovery na origem (stacks, volumes, GB)
        ↓
IP / usuário / SSH do destino
        ↓
Preflight (limpo? arch? espaço?)
        ↓
Resumo + digite MIGRAR
        ↓
Provision → Freeze → Transfer → Restore → Validate
        ↓
Relatório + apontar DNS
```

Log: `/var/log/impa-migrator.log`

## Depois da migração — DNS

Os domínios (Portainer, n8n, Evolution, etc.) ainda apontam para o IP antigo.

1. Altere os registros **DNS A** para o IP da VPS nova  
2. Aguarde a propagação  
3. Teste Traefik / Portainer / apps  
4. Só então cancele a VPS antiga  

Certificados Let's Encrypt (`volume_swarm_certificates`) são copiados para reduzir atrito no cutover; o desafio ACME pode exigir DNS já no IP novo.

## Rollback

Origem pausada, dados intactos. Para religar:

```bash
# por serviço
docker service scale NOME_DO_SERVICO=1

# ou redeploy da stack
docker stack deploy -c /root/STACK.yaml STACK
```

## O que NÃO está no MVP

- Clonar o SO inteiro (`rsync`/`dd` de `/`)
- Painel web / SaaS / login no navegador
- Ambientes só Docker Compose (sem Swarm) — detectados e abortados
- Troca de arquitetura (x86 → ARM)
- Recriar stacks pela API do Portainer (usa YAML + `docker stack deploy`)

## Teste recomendado

1ª rodada: Hostinger (origem Orion) → HostG (Debian/Ubuntu limpo).  
**Não** use VPS de cliente na primeira validação.

## Estrutura

```
vps/
├── impa-migrator.sh   # motor único
└── README.md
```

## Avisos

- Digite `MIGRAR` só depois de conferir o resumo.
- Tags `latest` em bancos podem quebrar no pull do destino; stacks Orion com versão fixa (`postgres:14`) são o cenário ideal.
- Se o `admin/init` do Portainer falhar, é comum enquanto o DNS ainda aponta para a origem — conclua o DNS e acesse o Portainer no destino.
