# 03 · Modelo de dados

> Nomes de pastas, tipos e campos são em **inglês**. O **conteúdo** das notas fica no seu idioma.

> **Estado (marco 1):** a estrutura do cérebro, o frontmatter, o `.cabecao.json` e o banco local (`.cabecao/cabecao.db`) existem. A branch de índice (`cabecao/index`) e o campo `embedding` do `.cabecao.json` são do **marco 2**. As relações tipadas e os fatos com validade como recurso de uso (tools `relate`, `facts`, `graph`) são do **marco 3** e estão na branch `feat/m3-grafo`, com o campo opcional `aliases` e as tabelas `names` e `mention_keys` no banco local.

## Estrutura do cérebro

```
meu-cerebro/                      ← repositório git (privado)
├── .cabecao.json                 ← marca a pasta como cérebro e guarda a configuração compartilhada
├── .gitattributes                ← log.md com merge por união
├── .gitignore                    ← ignora .cabecao/, temporários e lixo do sistema (ver abaixo)
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

### `.gitignore` do modelo

O `init` cria um `.gitignore` que exclui só o que é local ou só gera conflito:

```gitignore
.cabecao/
.cabecao-*.tmp
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.DS_Store
Thumbs.db
desktop.ini
```

O sync leva tudo o que o git não ignora ([04](04-sincronizacao.md), ADR 35). Por isso estas linhas importam: sem elas, o estado das janelas do Obsidian e o lixo do sistema virariam conflitos entre máquinas. Em um `.gitignore` que já existe (adoção de vault), o `init` acrescenta só as linhas que faltam, e o `doctor` confere.

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

O `indexMd` é lido em forma canônica: `wiki//Home.md` e `wiki/./Home.md` são o mesmo arquivo que `wiki/Home.md`.

**Configuração inválida.** Se o `.cabecao.json` não for JSON válido ou tiver um campo errado, o servidor MCP e a CLI recusam abrir o cérebro e dizem o que fazer: corrigir o arquivo (`git log -p -- .cabecao.json` mostra as versões anteriores). O `cabecao sync` continua rodando nesse caso, com a última versão válida do histórico (ou a configuração padrão, se não houver nenhuma), para que uma correção feita em outra máquina chegue. Um `.cabecao.json` inválido que chega do remoto, commitado por outro cliente git, não entra: o sync mantém a versão desta máquina e guarda a do remoto em `.cabecao.conflict-<máquina>-<data>.json`, num commit próprio, que vai para o remoto. O mesmo vale se o remoto apagar o arquivo. Uma versão válida, ou de esquema mais novo, entra como veio.

O campo `embedding` é do marco 2 (hoje o arquivo não o tem). Ele só existirá depois que você ativar a busca por significado e escolher um modelo. Ele vale para todas as máquinas do cérebro. O exemplo mostra uma das sugestões; as dimensões e o tamanho do registro nos segmentos acompanham o modelo escolhido.

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
edited_by: agent:claude-code       # só aparece quando um agente alterou uma nota sua (ver abaixo)
valid_from: 2026-05-03             # validade no tempo
valid_until:                       # vazio = ainda vale
supersedes: ["[[usar-rabbitmq-para-filas]]"]
superseded_by: []
expires_at:
aliases: [Amazon SQS]              # opcional: outros nomes da nota (acham menções sem link a ela)
# relações tipadas: UMA PROPRIEDADE POR TIPO, cada uma com uma lista de wikilinks
uses: ["[[SQS]]"]
decided_by: ["[[Ana]]"]
part_of: ["[[Projeto Atlas]]"]
---
```

### Proveniência e `edited_by`

`trust`, `origin` e `edited_by` registram quem escreveu e quanto confiar:

- Um agente (cliente MCP) não grava `trust: high` nem troca o `origin` de uma nota.
- Quando um agente altera uma nota que não foi criada por um agente (`origin: human`, `ingest:<fonte>`, ou sem `origin`, como as notas de um vault adotado) ou que tem `trust: high`, a nota ganha `edited_by: agent:<cliente>`, e o `trust` cai para `medium` se era `high`. Numa nota sem frontmatter, o Cabeção cria o bloco só com esse campo. A nota deixa de passar por "escrita pelo usuário" sem que isso fique registrado ([ADR 36](adr/README.md)). Uma nota com frontmatter ilegível não é alterada por agente, porque a edição não teria como ser registrada.
- O que o agente lê (`recall`, `search`, `read`) traz `edited_by` junto de `trust` e `origin`.

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

## Branch de índice (`cabecao/index`) · marco 2

Não existe no marco 1: o `init` não a cria e o sync só trabalha na branch principal. O que segue é o desenho.

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

SQLite embutido do Node, em modo WAL. É uma visão materializada, reconstruída em segundos (2 mil notas do zero em cerca de 640 ms). Fica dentro do cérebro, em `.cabecao/`, fora do git.

O esquema abaixo é o desenho; a implementação tem colunas e tabelas a mais (por exemplo `expires_at`, `conflict_of`, `archived`, `start_line`) e, no marco 1, só a busca por palavra-chave a usa. Os vetores e as tabelas de grafo para uso em busca são dos marcos 2 e 3.

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
