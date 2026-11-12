# 03 · Modelo de dados

> Nomes de pastas, tipos e campos são em **inglês**. O **conteúdo** das notas fica no seu idioma.

## Estrutura do cérebro

```
meu-cerebro/                      ← repositório git (privado)
├── .cabecao.json                 ← marca a pasta como cérebro e guarda a configuração compartilhada
├── .gitattributes                ← log.md com merge por união
├── .gitignore                    ← ignora .cabecao/
├── AGENTS.md                     ← regras do cérebro para qualquer agente
├── CLAUDE.md                     ← importa o AGENTS.md
├── index.md                      ← catálogo gerado (derivado; regenerado a cada sync)
├── log.md                        ← diário append-only
├── raw/                          ← fontes imutáveis
│   ├── articles/  meetings/  pdfs/  assets/
├── wiki/                         ← conhecimento sobre o mundo
│   └── sources/  concepts/  entities/  decisions/  syntheses/
├── memory/                       ← o que os agentes precisam saber para trabalhar com você
│   ├── rules/                    ← só você cria
│   ├── preferences/  gotchas/  procedures/
│   ├── facts/                    ← fatos atômicos com validade no tempo
│   ├── episodes/AAAA/MM/         ← o que aconteceu nas sessões
│   ├── handoffs/                 ← passagem de bastão entre sessões
│   └── _archive/                 ← memórias esquecidas
├── dashboards/                   ← painéis (.base) e mapas (.canvas) para o Obsidian
└── .cabecao/                     ← LOCAL, fora do git, invisível no Obsidian
    ├── index/                    ← cópia local da branch de índice
    ├── cabecao.db                ← banco de consulta
    └── locks/  logs/
```

### `.cabecao.json`

Único arquivo de configuração versionado. Ele permite adotar um vault que já existe sem mover nada.

```json
{
  "schemaVersion": 1,
  "noteDirs": ["wiki", "memory", "raw"],
  "indexMd": "index.md",
  "embedding": { "model": "embeddinggemma-300m", "variant": "q4", "dims": 768, "recipe": 1 }
}
```

## Frontmatter

```yaml
---
id: 01JD3K8Y6Z9W2T4N5P7Q8R0S1V     # ULID estável; sobrevive a renomeações
type: decision                     # source | concept | entity | decision | synthesis |
                                   # rule | preference | gotcha | procedure | fact | episode | handoff
title: Usar SQS para filas
scope: project:atlas               # global | project:<slug>
tags: [infra, filas]
sources: ["[[raw/meetings/2026-05-03-arquitetura]]"]
trust: high                        # high (você) | medium (agente) | low (conteúdo externo)
origin: agent:claude-code          # human | agent:<client> | ingest:<source>
created: 2026-05-03
updated: 2026-11-12
confirmed: 2026-11-12
valid_from: 2026-05-03             # validade no tempo
valid_until:                       # vazio = ainda vale
supersedes: ["[[usar-rabbitmq-para-filas]]"]
superseded_by: []
expires_at:
# relações tipadas: UMA PROPRIEDADE POR TIPO, cada uma com uma lista de wikilinks
uses: ["[[SQS]]"]
decided_by: ["[[Ana]]"]
part_of: ["[[Projeto Atlas]]"]
---
```

### Por que uma propriedade por tipo de relação

O rascunho anterior usava uma lista de objetos (`relations: [{type, target}]`). No Obsidian real, isso aparece como JSON cru, não é editável e não é pesquisável. Com uma propriedade por relação, cada uma vira um campo de lista editável, os wikilinks viram arestas no grafo e backlinks, e os painéis conseguem filtrar por elas.

O conjunto inicial de relações é pequeno e fixo: `uses`, `part_of`, `depends_on`, `decided_by`, `works_on`, `related_to`, além de `supersedes`. Você pode acrescentar outras no `.cabecao.json`.

### Fatos atômicos (`memory/facts/`)

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
---
O Projeto Atlas migrou de RabbitMQ para SQS em maio de 2026 por custo operacional.
```

Um fato novo que contradiz outro **não apaga** o antigo: o antigo recebe `valid_until` e `superseded_by`. Na medição, usar essas datas na busca derrubou de 50–70% para 0% os casos em que a versão vencida aparecia acima da correta.

## Branch de índice (`cabecao/index`)

Fica no mesmo repositório, numa branch separada e sem histórico em comum com as notas. Só o Cabeção escreve nela.

```
embeddings/<modelo>-<variante>-r<receita>/
    seg-<hash>.bin        ← segmentos imutáveis
graph/
    nodes.jsonl  edges.jsonl
manifest.json             ← versão, modelo, commit de conteúdo indexado
```

### Segmento de embeddings

Um segmento é um arquivo **imutável**, nomeado pelo hash do próprio conteúdo. Cada registro tem:

| Campo | Tamanho | Conteúdo |
|---|---|---|
| chave | 16 bytes | hash do texto que foi embutido |
| escala | 4 bytes | fator para reconstruir o vetor |
| vetor | 768 bytes | 768 dimensões em `int8` |

O arquivo termina com um checksum; um segmento incompleto é ignorado.

Formato escolhido por medição: `int8` com escala por vetor manteve a qualidade do `float32` (0,872 nos dois) com um quarto do tamanho. Dez mil trechos ocupam cerca de 7 MB no git.

Como nenhum arquivo é alterado depois de criado, duas máquinas nunca editam o mesmo arquivo, e não existe conflito por construção.

### O que recalcula um embedding

A chave é o hash do texto embutido: o prefixo de contexto (`Título › Seção`) mais o texto do trecho.

| Mudança | Recalcula? |
|---|---|
| Mover ou renomear o arquivo | Não |
| Mudar frontmatter (tags, datas, relações) | Não |
| Editar um parágrafo | Só os trechos afetados |
| Mudar o título da nota | Os trechos da nota |
| Trocar o modelo ou a receita | Tudo, em outra pasta; os dois convivem durante a troca |

## Banco local (`.cabecao/cabecao.db`)

SQLite embutido do Node, em modo WAL. É uma visão materializada, reconstruída em segundos.

```sql
notes(id TEXT PRIMARY KEY, path TEXT UNIQUE, type, title, scope, trust, origin,
      created, updated, confirmed, valid_from, valid_until,
      content_hash, mtime, size, frontmatter JSON)
chunks(id INTEGER PRIMARY KEY, note_id, ord, heading_path, text, token_count, chunk_key)

CREATE VIRTUAL TABLE chunks_fts USING fts5(text, title_path,
       content='chunks', content_rowid='id',
       tokenize='unicode61 remove_diacritics 2');

edges(src_note, dst_note, type, origin,   -- wikilink | relation | fact | supersedes | mention
      valid_from, valid_until)
facts(note_id, subject, predicate, object, valid_from, valid_until)
state(key PRIMARY KEY, value)             -- último commit indexado, versão do esquema
```

Os vetores não ficam em tabela de busca vetorial: são carregados dos segmentos para um `Int8Array` em memória (100 mil vetores carregam em 18 a 44 ms).

## Versionamento do esquema

`schemaVersion` fica no `.cabecao.json`. `cabecao upgrade` aplica as migrações em ordem, um commit por migração, com um ponto de restauração antes.
