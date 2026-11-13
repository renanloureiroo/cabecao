---
title: .cabecao.json
description: O arquivo de configuração do cérebro, versionado e compartilhado entre as máquinas.
sidebar_position: 3
---

O `.cabecao.json` fica na raiz do cérebro. Ele marca a pasta como cérebro do Cabeção e guarda a configuração que vale para todas as máquinas: vai para o git e viaja pelo sync. O que é só desta máquina fica em [`~/.config/cabecao/config.json`](./arquivos.md#configuração-da-máquina).

## O arquivo de um cérebro novo

```json
{
  "schemaVersion": 1,
  "noteDirs": [
    "wiki",
    "memory",
    "raw"
  ],
  "indexMd": "index.md"
}
```

## Campos

| Campo | Tipo | Padrão | O que é |
| --- | --- | --- | --- |
| `schemaVersion` | inteiro | `1` | Versão do formato do cérebro. Um cérebro com versão maior do que a que este Cabeção entende pede para atualizar o Cabeção |
| `noteDirs` | lista de pastas | `["wiki", "memory", "raw"]` | Onde ficam as notas, relativas à raiz. `"."` é a raiz inteira (um vault adotado com notas soltas na raiz). Pastas ocultas não valem |
| `indexMd` | caminho `.md` | `"index.md"` | Onde o catálogo é gerado |
| `relations` | lista de nomes | `[]` | Relações tipadas suas, além das seis fixas |
| `commit` | objeto | ausente | O modelo do assunto dos commits |
| `embedding` | objeto | ausente | Reservado para a busca por significado, [em breve](../em-breve.md). Hoje não tem efeito |
| `llm_policy` | objeto | ausente (sem restrição) | O que um provedor de respostas do `ask` pode receber deste cérebro. Veja [Política por cérebro](../guias/respostas-com-modelo.md#política-por-cérebro) |

Chaves que o Cabeção não conhece são mantidas quando ele regrava o arquivo.

### relations

Nomes em minúsculas, dígitos e `_`, que não coincidam com um campo do frontmatter (`id`, `type`, `title`, `scope`, `tags`...):

```json
{
  "schemaVersion": 1,
  "noteDirs": ["wiki", "memory", "raw"],
  "indexMd": "index.md",
  "relations": ["mentored_by", "blocks"]
}
```

Cada nome vira uma propriedade aceita no frontmatter (`mentored_by: ["[[Ana Prado]]"]`), uma aresta no grafo e um `type` aceito pela tool `relate` e por `cabecao graph --type`.

### commit

O assunto dos commits que o Cabeção faz. O padrão imita o plugin Obsidian Git:

```json
{
  "commit": {
    "message": "vault backup: {{date}}",
    "dateFormat": "YYYY-MM-DD HH:mm:ss.SSS"
  }
}
```

Marcadores de `message`:

| Marcador | Vira |
| --- | --- |
| `{{date}}` | A data e a hora, no formato de `dateFormat` e no fuso da máquina |
| `{{hostname}}` | O nome da máquina |
| `{{numFiles}}` | Quantos arquivos o commit muda |
| `{{action}}` | A ação: `add`, `update`, `revert`, `edit`, `conflict`... |
| `{{session}}` | Os 8 primeiros caracteres da sessão do agente (vazio em edições suas) |

`dateFormat` usa os marcadores do Moment.js (`YYYY`, `MM`, `DD`, `HH`, `mm`, `ss`, `SSS`, `dddd`, `MMMM`...) e aceita texto literal entre colchetes, como `[às] HH:mm`. Os nomes de mês e de dia saem em inglês.

O corpo e os rodapés (`Cabecao-Op`, `Cabecao-Session`...) não mudam: o `undo` depende deles. Veja [Commits e undo](../conceitos/commits-e-undo.md).

### llm_policy

Vale em todas as máquinas do cérebro e só restringe: o provedor em si é escolhido em cada máquina, com `cabecao llm on`.

```json
{
  "llm_policy": { "allow": "agent", "exclude_paths": ["memory/private/**"], "exclude_types": [], "exclude_trust": ["low"] }
}
```

`allow` é `"any"` (padrão), `"agent"` (só o agente instalado) ou `"none"` (nunca chama provedor). Um `llm_policy` inválido não quebra o cérebro: ele fecha o envio (nada sai) e o `doctor` diz o que corrigir.

## Quando o arquivo quebra

Um `.cabecao.json` com JSON inválido ou um campo errado faz o `status`, o `doctor` e as tools apontarem o problema, com a correção:

> Corrija o .cabecao.json do cérebro (é JSON; "git log -p -- .cabecao.json" mostra as versões anteriores, inclusive a última que funcionava) ou desfaça a mudança que o quebrou. O "cabecao sync" continua rodando com a última configuração válida do histórico, então uma correção feita em outra máquina chega por ele.

Uma versão quebrada que chega do remoto não substitui a sua: ela vai para `.cabecao.conflict-<máquina>-<data>.json`.
