---
title: Criar regras
description: Regras são instruções que todo agente segue. Só você cria; veja como escrever uma.
sidebar:
  order: 6
---

Uma regra é uma nota `type: rule` em `memory/rules/`. Ela vem em primeiro lugar no `recall` de toda tarefa, acima de preferências e memórias, e só perde para a sua instrução do momento.

## Só você cria

Um agente não consegue gravar uma regra. Se tentar, recebe:

```json
{
  "error": {
    "code": "rule_requires_human",
    "message": "regras (type: rule) só o usuário cria e altera; um agente não pode gravá-las",
    "next_step": "Grave como preferência (type: preference) ou proponha a regra ao usuário; ele a cria com a CLI ou no Obsidian."
  }
}
```

Isso protege você de uma nota maliciosa ou de um agente confuso que tente mudar o comportamento de todos os outros. Um agente pode **propor** uma regra: ele a escreve como síntese em `wiki/syntheses/` e você decide.

## Escrever uma regra

Crie um arquivo em `memory/rules/`, no Obsidian ou em qualquer editor:

```markdown title="memory/rules/commits-em-portugues.md"
---
type: rule
title: Commits em português
scope: global
origin: human
---
Escreva mensagens de commit em português, no imperativo.
```

Os campos que importam:

- `type: rule`;
- `origin: human`: sem ele, a nota não entra como regra no `recall`. É a sua assinatura;
- `scope`: `global` para valer em tudo, ou `project:<nome>` para um projeto;
- `title`: curto, para você achar depois.

O `id` é opcional numa nota escrita à mão; sem ele, o Cabeção identifica a nota pelo caminho.

Rode `cabecao sync` para levar a regra às outras máquinas. Na mesma máquina, ela já vale no próximo `recall`, sem sync. Este é o `recall` real logo depois de salvar o arquivo acima:

```json
{
  "rules": [
    {
      "id": "path:memory/rules/commits-em-portugues.md",
      "path": "memory/rules/commits-em-portugues.md",
      "type": "rule",
      "title": "Commits em português",
      "scope": "global",
      "validity": "current",
      "trust": null,
      "origin": "human",
      "edited_by": null,
      "sources": [],
      "content_kind": "note",
      "content": "Escreva mensagens de commit em português, no imperativo."
    }
  ]
}
```

(Só o trecho das regras; o resto do briefing foi omitido.)

## Boas regras

- **Uma regra por nota.** Fica fácil de achar, mudar e desfazer.
- **Imperativo e concreto.** "Rode `make db-reset` antes dos testes de integração" é melhor que "cuide do banco".
- **Só o que vale sempre.** Gosto pessoal que admite exceção é preferência (`type: preference`); deixe os agentes gravarem essas.
- **Poucas.** Todas as regras vigentes entram em todo `recall` e ocupam espaço no orçamento de tokens do briefing.

## Mudar ou aposentar uma regra

Edite o arquivo. Para aposentar sem apagar o histórico, acrescente `valid_until: AAAA-MM-DD` ou escreva uma regra nova com `supersedes: ["[[regra-antiga]]"]`. Uma nota de agente que diga substituir a sua regra não a derruba: só outra regra sua faz isso.
