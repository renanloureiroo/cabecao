# 03 · Modelo de dados

> **Convenção:** nomes de pastas, tipos e campos do schema são em **inglês** (como as tools do MCP), para o projeto servir a qualquer público. O **conteúdo** das notas fica no idioma do usuário. Ver [ADR-0008](adr/0008-identificadores-em-ingles.md).

## Estrutura do cérebro (repositório do usuário)

```
meu-cerebro/                      ← repositório git (privado)
├── AGENTS.md                     ← schema/regras para qualquer agente
├── CLAUDE.md                     ← importa AGENTS.md (@AGENTS.md) + extras do Claude
├── index.md                      ← catálogo gerado (1 linha por página)
├── log.md                        ← diário append-only (ingest, lint, sync)
├── raw/                          ← FONTES IMUTÁVEIS
│   ├── articles/  meetings/  pdfs/  assets/
├── wiki/                         ← conhecimento compilado (escrito pela IA, revisado por você)
│   ├── sources/  concepts/  entities/  decisions/  syntheses/
│   └── _communities/             ← resumos de comunidades do grafo (gerados)
├── memory/                       ← memória de agente
│   ├── rules/                    ← regras (só o humano cria ou aprova)
│   ├── preferences/  gotchas/  procedures/
│   ├── facts/                    ← fatos atômicos com validade temporal
│   ├── episodes/AAAA/MM/         ← observações e eventos de sessões
│   ├── handoffs/                 ← passagem de bastão entre sessões
│   └── _archive/                 ← memórias esquecidas (fora do índice ativo)
├── dashboards/                   ← arquivos .base e .canvas para o Obsidian
└── .cabecao/                     ← DERIVADOS (o Obsidian ignora pastas ocultas)
    ├── manifest.json             ← versão do schema, modelos, último commit indexado
    ├── config.json               ← configuração compartilhada entre máquinas
    ├── embeddings/<modelo>/      ← vetores endereçados por conteúdo (sincronizados)
    ├── graph/                    ← nodes.jsonl, edges.jsonl, communities.jsonl (sincronizados)
    └── cache/                    ← cabecao.db, locks, logs (NÃO versionado)
```

**Wiki ou memory?** `wiki/` é conhecimento sobre o mundo (o que você estuda e decide). `memory/` é o que os agentes precisam saber para trabalhar com você (como agir). Decisões ficam **só** em `wiki/decisions/`.

## Frontmatter

Todo arquivo em `wiki/` e `memory/` segue um schema validado (Zod). Campos comuns:

```yaml
---
id: 01JD3K8Y6Z9W2T4N5P7Q8R0S1V      # ULID estável (sobrevive a renomeações)
type: decision                      # source | concept | entity | decision | synthesis |
                                    # rule | preference | gotcha | procedure | fact | episode | handoff
title: Usar SQS para filas
scope: project:atlas                # global | user | project:<slug> | org:<slug>
tags: [infra, filas]
sources: ["[[raw/meetings/2026-05-03-arquitetura]]"]
trust: high                         # high (humano) | medium (agente) | low (conteúdo externo)
origin: agent:claude-code           # human | agent:<client> | ingest:<source>
created: 2026-05-03
updated: 2026-11-12
confirmed: 2026-11-12               # última vez que alguém confirmou que ainda vale
valid_from: 2026-05-03              # validade temporal (opcional)
valid_until:                        # vazio = ainda válido
supersedes: ["[[usar-rabbitmq-para-filas]]"]
superseded_by:
expires_at:                         # TTL (opcional; ex.: memórias de sessão)
relations:                          # arestas tipadas do grafo
  - { type: uses, target: "[[SQS]]" }
  - { type: decided_by, target: "[[Ana]]" }
---
```

### Fatos atômicos (`memory/facts/`)
Fatos são pequenos e temporais, ideais para perguntas do tipo "o que era verdade em março?":

```yaml
---
id: 01JD...
type: fact
subject: "[[Projeto Atlas]]"
predicate: uses_queue
object: "[[SQS]]"
valid_from: 2026-05-03
valid_until:
supersedes: ["[[fato-atlas-usa-rabbitmq]]"]
trust: high
sources: ["[[raw/meetings/2026-05-03-arquitetura]]"]
---
O Projeto Atlas migrou de RabbitMQ para SQS em maio de 2026 por custo operacional.
```

> **Por que fatos e relações extraídos por LLM ficam em Markdown e não num banco?** Porque são **caros de gerar** e **valiosos para auditar**. Em Markdown eles sincronizam pelo git, aparecem no Obsidian e podem ser corrigidos à mão.

## Índice local (SQLite)

`.cabecao/cache/cabecao.db` é uma **visão materializada**, reconstruída de forma incremental a partir do repositório. Roda em modo WAL, que permite vários processos lendo e escrevendo ao mesmo tempo.

```sql
-- documentos e trechos
notes(id TEXT PK, path TEXT UNIQUE, type, title, scope, trust, origin,
      created, updated, confirmed, valid_from, valid_until, superseded_by,
      content_hash TEXT, frontmatter JSON)
chunks(id INTEGER PK, note_id, ord, heading_path, text, token_count,
       chunk_key TEXT)

-- texto completo (BM25); heading_path já inclui o título da nota
CREATE VIRTUAL TABLE chunks_fts USING fts5(text, heading_path,
       content='chunks', content_rowid='id',
       tokenize='unicode61 remove_diacritics 2');

-- vetores (sqlite-vec); uma tabela por modelo ativo
CREATE VIRTUAL TABLE vec_<modelo> USING vec0(chunk_id INTEGER PRIMARY KEY,
       embedding float[<dim>] distance_metric=cosine);

-- grafo
edges(src_note, dst_note, type,
      origin,            -- wikilink | relation | fact | supersedes | inferred
      valid_from, valid_until, weight)
entities(id, name, aliases JSON, note_id)
communities(id, level, parent, summary_note_id)
community_members(community_id, note_id)

-- operação
index_state(key PK, value)  -- last_indexed_commit, schema_version...
```

## Endereçamento por conteúdo

| Chave | Fórmula | Uso |
|---|---|---|
| `content_hash` | `sha256(arquivo)` | Detectar mudança de nota |
| `chunk_key` | `sha256(texto que vai para o embedding)` = prefixo de contexto (`Título › Seção`) + texto normalizado do trecho | Reaproveitar o embedding quando o trecho não mudou |
| `embedding_key` | `sha256(embedding_spec + ":" + chunk_key)` | Chave no armazenamento sincronizado de embeddings |

`embedding_spec` identifica tudo que muda o vetor: modelo, quantização, dimensões e a versão da receita de prefixos.

O que recalcula embeddings e o que não:

| Mudança | Recalcula? |
|---|---|
| Mover ou renomear o **arquivo** (mesmo título) | Não |
| Mudar frontmatter (tags, scope, trust, datas) | Não |
| Editar um parágrafo | Só os trechos afetados |
| Mudar o **título** da nota | Todos os trechos da nota (o título faz parte do prefixo) |
| Renomear uma seção | Os trechos daquela seção |

## Versionamento do schema

`manifest.json`:
```json
{
  "schemaVersion": 1,
  "cabecaoVersion": "0.1.0",
  "embedding": { "active": "multilingual-e5-small@onnx-q8", "dims": 384 },
  "lastIndexedCommit": "a1b2c3d",
  "createdAt": "2026-11-12"
}
```
`cabecao upgrade` aplica as migrações em sequência (`schemaVersion` N → N+1) e faz um commit separado para cada uma.
