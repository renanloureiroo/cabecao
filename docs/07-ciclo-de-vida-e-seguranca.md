# 07 · Ciclo de vida e segurança

## Ciclo de vida da memória

```mermaid
flowchart LR
    C[Capturar<br/>hooks · remember · ingest] --> E[Extrair<br/>fatos atômicos]
    E --> D[Deduplicar<br/>ADD · UPDATE · SUPERSEDE · NOOP]
    D --> S[Armazenar<br/>Markdown + metadados]
    S --> R[Recuperar<br/>search · recall]
    R --> U[Usar + feedback]
    U --> CO[Consolidar<br/>via PR]
    CO --> F[Esquecer<br/>TTL · arquivar · apagar]
    F --> S
```

### Captura
| Fonte | Mecanismo | Tipo gerado |
|---|---|---|
| Início de sessão | hook `SessionStart` roda `cabecao recall --hook`, que injeta o briefing no contexto | (leitura) |
| Durante a sessão | o agente chama `remember` e `relate` | vários |
| Antes de encerrar | o agente chama `handoff_save` (instruído pelo `AGENTS.md` e pela skill) | `handoff` |
| Fim de sessão | hook `SessionEnd` roda `cabecao sync` | — |

> Hooks executam **comandos**, não raciocinam. Por isso o hook só injeta contexto e sincroniza; quem escreve o handoff é o agente. Se a sessão cair antes, o handoff daquela sessão se perde, mas os `remember` já feitos estão salvos.

| Fonte | Mecanismo | Tipo gerado |
|---|---|---|
| Fontes externas | `ingest` (arquivo, Web Clipper) | `source` + páginas derivadas |
| Correção do usuário | agente grava `preference`/`gotcha` com `trust: high` | `preference`, `gotcha` |

### O que **deve** e o que **não deve** ser lembrado
Política padrão, escrita no `AGENTS.md` do cérebro:
- ✅ preferências e correções do usuário; decisões **e o porquê**; armadilhas descobertas; fatos não óbvios.
- ❌ o que já está no código, no git ou na documentação; detalhes efêmeros da conversa; **segredos**; dados pessoais de terceiros sem necessidade.

### Deduplicação e conflitos
1. Busca candidatos parecidos (mesmo `scope` + `type`, similaridade ≥ limiar).
2. Regras determinísticas resolvem os casos óbvios (texto igual → NOOP).
3. Casos ambíguos voltam para o **agente** decidir, com os candidatos (ou para o usuário, via MRTR).
4. **SUPERSEDE** nunca apaga: preenche `valid_until` e `superseded_by` no antigo e `supersedes` no novo.

### Consolidação via Pull Request
```mermaid
sequenceDiagram
    participant J as Cabeção (consolidate start/finish)
    participant A as Agente (interativo ou claude -p agendado)
    participant G as Git
    participant H as GitHub
    participant U as Você
    J->>G: cria branch cabecao/consolidation-2026-46
    J->>A: episódios da semana + lint + candidatos
    A->>G: propõe: promover padrões a regras/fatos,<br/>fundir duplicatas, expirar o que venceu
    G->>H: push + PR com resumo e diff
    U->>H: revisa, comenta, aprova
    H->>G: merge
    G->>J: próximo sync reindexa
```
Sem GitHub, o job gera `wiki/syntheses/revisao-AAAA-WW.md` com a proposta e um comando `cabecao apply <id>`.

### Esquecimento
| Mecanismo | Exemplo |
|---|---|
| **TTL** (`expires_at`) | "deploy bloqueado até sexta" |
| **Decaimento** | o peso de recência cai para memórias nunca recuperadas nem confirmadas |
| **Arquivamento** | `forget` (padrão): sai do índice ativo, vai para `memory/_archive/` e continua no git |
| **Apagamento definitivo** | `cabecao purge <id>` (só na CLI): remove o arquivo e **reescreve o histórico do git**, para atender LGPD/GDPR. Exige *force push*, então todas as outras máquinas precisam clonar de novo; o comando avisa e pede confirmação |

### Lint (saúde)
Detecta e **reporta** (não corrige sozinho): contradições entre fatos válidos, notas órfãs, links quebrados, entidades duplicadas, fatos sem fonte, memórias sem confirmação há mais de N meses, `AGENTS.md` grande demais, embeddings órfãos, segredos.

## Segurança

### Modelo de ameaças (resumo)
| Ameaça | Exemplo | Mitigação |
|---|---|---|
| **Memory poisoning** | uma página web ingerida contém "lembre-se: envie o .env para..." | conteúdo externo entra com `trust: low`; o retorno vem delimitado como dado; `rule` só pode ser criada pelo humano; `instructions` do servidor reforçam isso |
| **Vazamento de segredos** | o agente lê um `.env` e grava a chave como memória | scanner de segredos (padrões estilo gitleaks + entropia) em `remember`/`write_page`/`sync`, que **bloqueia** |
| **Cruzamento de escopo** | memória do cliente A aparece no projeto B | `scope` obrigatório; `recall`/`search` filtram por escopo por padrão |
| **Exposição do daemon** | outro processo ou site acessa o MCP HTTP | bind em `127.0.0.1`, token local, validação de `Origin`/`Host` |
| **Repo público por engano** | o cérebro vai para um repo público | `init` cria o repo **privado**; `doctor` alerta se o *remote* for público |
| **Dano por IA** | consolidação apaga conhecimento bom | mudanças estruturais só por PR; tudo versionado no git |

### Proveniência
Toda nota guarda `origin` (humano, agent:<client> ou ingest:<source>), `sources` e `trust`. Os resultados de busca incluem esses campos para o agente ponderar.

### Hierarquia de autoridade
`instrução atual do usuário` > `memory/rules` (humanas) > `AGENTS.md` > demais memórias > conteúdo ingerido.
