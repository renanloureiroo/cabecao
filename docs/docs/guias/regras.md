---
title: Criar regras
description: Regras são instruções que todo agente segue. Você cria, ou pede a um agente e confirma; veja como.
sidebar_position: 6
---

Uma regra é uma nota `type: rule` em `memory/rules/`. Ela vem em primeiro lugar no `recall` de toda tarefa, acima de preferências e memórias, e só perde para a sua instrução do momento.

## Só com o seu pedido

Um agente só grava uma regra quando você pede, e com confirmação. Sem ela, a primeira chamada não grava nada e devolve o resumo e um token de confirmação:

```json
{
  "decision": "needs_confirmation",
  "status": "confirmation_required",
  "summary": "Criar (ou atualizar, se já houver uma parecida) a REGRA \"Testes antes do push\" em memory/rules/, escopo global. Conteúdo (34 caracteres): \"Rode os testes antes de cada push.\".",
  "confirm_token": "cbc_ct_...",
  "next_step": "Isto exige pedido explícito do usuário. Mostre o resumo (summary) ao usuário e pergunte; só repita a chamada de remember com os mesmos argumentos e confirm_token se ele disser sim, em até 5 minutos. ..."
}
```

O agente mostra o resumo e pergunta; só repete a chamada com o token se você disser sim. Num cliente que sabe perguntar (elicitação), o próprio servidor pergunta a você. A regra gravada assim fica com `origin: agent:<cliente>`, `approved_by: user` e `approved_at`, e aparece no `cabecao lint` (regra `agent_approved`) para você revisar.

Isso protege você de uma nota maliciosa ou de uma fonte ingerida que tente fazer um agente mudar o comportamento de todos os outros: um pedido que veio de um conteúdo lido não é pedido seu, e a resposta diz isso ao agente. **O token prova que a ação foi intencional e é a que foi mostrada, não que você disse sim**: num cliente sem elicitação, quem afirma é o agente. Por isso confira o `lint` de vez em quando e desfaça com `cabecao undo` o que não pediu.

Pela CLI, no seu terminal, `cabecao remember --type rule` pergunta e você confirma digitando; veja [Quem é humano e quem é agente na CLI](./humano-e-agente.md).

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
- `origin: human`: sem ele (ou sem a marca de aprovação de uma regra gravada por agente a seu pedido), a nota não entra como regra no `recall`. É a sua assinatura;
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

Edite o arquivo. Para aposentar sem apagar o histórico, acrescente `valid_until: AAAA-MM-DD` ou escreva uma regra nova com `supersedes: ["[[regra-antiga]]"]`. Uma nota de agente que diga substituir a sua regra não a derruba: só outra regra sua (ou aprovada por você) faz isso.
