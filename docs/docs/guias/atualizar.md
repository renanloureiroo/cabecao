---
title: Atualizar e desinstalar
description: Atualize o programa (do jeito que você instalou), aplique as migrações do cérebro com cabecao upgrade, e tire o Cabeção da máquina com cabecao uninstall sem tocar no cérebro.
sidebar_position: 12
---

Atualizar tem duas partes: o **programa** (o pacote `cabecao`, o plugin do Claude Code, o pacote do Claude Desktop) e, de vez em quando, o **cérebro**, quando uma versão nova muda o formato dele. No fim desta página está como [desinstalar](#desinstalar).

## O programa

O comando depende de como você instalou. O `cabecao doctor` mostra o da sua instalação na primeira linha:

```text
ok     Cabeção                  1.0.0 (instalado com npm -g); para atualizar: npm i -g cabecao@latest
```

| Instalou com | Para atualizar |
| --- | --- |
| `npm i -g` | `npm i -g cabecao@latest` |
| `pnpm add -g` | `pnpm add -g cabecao@latest` |
| `npx` | `npx cabecao@latest <comando>` (o `npx` usa a versão que você pedir) |
| Dentro de um projeto | `npm i cabecao@latest`, na pasta do projeto |
| Plugin do Claude Code | `/plugin update cabecao@cabecao` |

As mensagens da CLI que mandam atualizar (um cérebro de versão mais nova, o sync agendado que perdeu o programa) já dizem o comando da sua instalação. O pacote do Claude Desktop se atualiza instalando o `.mcpb` novo por cima ([Claude Desktop](./claude-desktop.md)). Nada disso mexe no cérebro.

Depois de atualizar, rode `cabecao install-skills` de novo se você instalou as [skills](./skills.md): ele troca só as que continuam como o Cabeção gravou. O `doctor` avisa quando elas ficaram de uma versão anterior. Se o Node mudou (nvm, fnm, Volta), rode também `cabecao install-client --all`: o registro nos clientes aponta para o caminho do Node, e o `doctor` acusa quando ele não existe mais.

Atualize todas as máquinas que usam o mesmo cérebro. Veja abaixo o que acontece com uma máquina que ficou para trás.

## O esquema do cérebro: `cabecao upgrade`

O `.cabecao.json` guarda a versão do formato do cérebro, o `schemaVersion`. Quando uma versão do Cabeção muda esse formato, ela traz uma **migração**, e `cabecao status` e `cabecao doctor` avisam com uma linha assim (o formato; hoje ela não aparece, porque não há migração):

```text
Atualização: 1 migração pendente do esquema 1 para o 2. Rode "cabecao upgrade".
```

Hoje o esquema é o 1 e não há migração nenhuma: o comando só confirma.

```text
$ cabecao upgrade
Esquema 1: em dia (este Cabeção usa o 1). Nenhuma migração pendente.
```

Quando houver migração, o `cabecao upgrade`:

1. só roda com o cérebro **limpo e sincronizado**: rode `cabecao sync` antes (com mudanças fora de commit ou commits ainda não enviados, ele recusa e diz isso);
2. cria um **ponto de restauração**, a tag local `cabecao/restore/<data>-upgrade`;
3. aplica as migrações em ordem, **um commit por migração** (`migrate: <o que mudou> (esquema 1 → 2)`), todas na mesma sessão;
4. termina dizendo como desfazer: `cabecao undo --session <id>` desfaz a atualização inteira, e `git reset --hard <tag>` volta ao ponto de restauração.

`cabecao upgrade --dry-run` mostra as migrações e os arquivos que mudariam, sem gravar nada. Rodar de novo, já atualizado, não faz nada. Depois, rode `cabecao sync`.

### Máquinas com versões diferentes

A regra de compatibilidade é esta:

- **Cabeção novo, cérebro de esquema anterior**: funciona normalmente, com o aviso da migração pendente. Quem decide quando migrar é você.
- **Cabeção antigo, cérebro de esquema mais novo**: o Cabeção recusa abrir o cérebro (CLI e servidor MCP) e diz para atualizar. O `cabecao sync` de uma máquina antiga **não aplica nem envia nada** quando o remoto já está num esquema mais novo: as mudanças dela ficam em commits locais, e vão no primeiro sync depois de você atualizar o Cabeção naquela máquina.

```text
$ cabecao sync
Sync: bloqueado. O cérebro no remoto foi atualizado para o esquema 2 por uma versão mais nova do Cabeção, e este Cabeção só entende até o 1. Nada do remoto foi aplicado e nada foi enviado; as mudanças desta máquina estão em commits locais. Atualize o Cabeção nesta máquina e rode o sync de novo.
Recebidos: 0 commits · enviados: 0 · criados neste sync: 1
Próximo passo: Atualize o Cabeção nesta máquina e rode o sync de novo ("cabecao doctor" mostra o comando para a sua instalação); até lá, as mudanças daqui ficam em commits locais e nada é enviado.
Para atualizar: npm i -g cabecao@latest
```

Uma mudança de esquema só sai em versão menor ou maior do pacote, nunca numa correção.

## O modelo do cérebro: `cabecao upgrade --template`

O `init` grava um `AGENTS.md` (as regras do cérebro para os agentes), um `CLAUDE.md`, um `.gitignore` e um `.gitattributes`. Versões novas do Cabeção às vezes melhoram esse modelo: o `AGENTS.md` das betas `0.1.0-beta.0` e `beta.1`, por exemplo, ainda manda gravar o handoff com `remember`, e hoje há a tool `handoff_save`. Esses arquivos são seus, então a atualização é **opcional e nunca passa por cima do que você editou**:

- um arquivo igual ao modelo de uma versão anterior (você nunca o editou) é trocado pelo atual;
- um arquivo que você editou mostra a diferença e pergunta; sem terminal (ou se você disser não), fica como está, e o modelo atual vai para `.cabecao/template/<arquivo>`, para você comparar e juntar à mão; `--yes` troca sem perguntar;
- no `.gitignore` e no `.gitattributes`, só acrescenta as linhas que faltam, no fim;
- um arquivo que não existe não é recriado;
- tudo num commit, que `cabecao undo --op <id>` desfaz.

O `cabecao status` avisa quando há atualização do modelo. Num cérebro criado por uma dessas betas:

```text
$ cabecao upgrade --template --dry-run
Modelo do cérebro: ~/cabecao (simulação: nada foi gravado)
  AGENTS.md: modelo de uma versão anterior, sem edição sua: será trocado
  CLAUDE.md: igual ao modelo atual
  .gitignore: igual ao modelo atual
  .gitattributes: igual ao modelo atual
Rode sem --dry-run para aplicar (os arquivos editados por você só mudam se você confirmar).

$ cabecao upgrade --template
Modelo do cérebro: ~/cabecao
  AGENTS.md: modelo de uma versão anterior, sem edição sua: será trocado
  CLAUDE.md: igual ao modelo atual
  .gitignore: igual ao modelo atual
  .gitattributes: igual ao modelo atual
  ~ AGENTS.md: trocado pelo modelo atual
Commit b3ea13bf2c; "cabecao undo --op 01M7AKWKSKNEWJ4XXPNDP69ZEV" desfaz. Rode "cabecao sync" depois.
```

Num cérebro com o `AGENTS.md` editado e o `.gitignore` curto (um vault adotado, por exemplo):

```text
$ cabecao upgrade --template
Modelo do cérebro: ~/cabecao
  AGENTS.md: editado por você
  CLAUDE.md: igual ao modelo atual
  .gitignore: faltam linhas do modelo (.cabecao-*.tmp, .obsidian/workspace.json, .obsidian/workspace-mobile.json, .DS_Store, Thumbs.db, desktop.ini)
  .gitattributes: igual ao modelo atual
Diferença entre o seu AGENTS.md e o modelo atual:
    --- seu AGENTS.md
    +++ modelo atual
    ...
  ~ .gitignore: linhas acrescentadas
  = AGENTS.md: mantido como está; o modelo atual ficou em .cabecao/template/AGENTS.md para você comparar
Commit 6e2b2ec7ce; "cabecao undo --op 01M7AKW4EGWA9XY09SJ7V2DQDT" desfaz. Rode "cabecao sync" depois.
```

Os painéis do Obsidian em `dashboards/` seguem a mesma regra pelo `cabecao obsidian setup`: um painel que você editou nunca é substituído ([Obsidian](./obsidian.md)).

## Desinstalar

O npm não roda nada quando desinstala um pacote. Por isso, antes de tirar o programa, rode `cabecao uninstall`: ele tira desta máquina tudo o que o Cabeção pôs **fora do cérebro**:

- o registro do servidor MCP em todos os clientes de IA (como `cabecao install-client --remove`);
- as skills que ele instalou (as que você alterou ficam);
- o sync agendado (como `cabecao schedule off`);
- a configuração da máquina (`~/.config/cabecao`, ou a pasta de `CABECAO_CONFIG_DIR`);
- o provedor das [respostas com um modelo](./respostas-com-modelo.md), se você ativou: o `llm.json` e as chaves guardadas, no cofre do sistema e no arquivo (se o cofre recusar apagar uma chave, o `uninstall` diz qual);
- o cache: o runtime e os modelos da busca por significado e os registros das consolidações (`--keep-cache` mantém).

O **cérebro nunca é tocado**: ele é seu, está no git e no remoto. A cópia `.bak` que o `install-client` guardou do arquivo original de cada cliente também fica.

Veja antes o que sairia; qualquer um, até um agente, pode rodar o `--dry-run`:

```text
$ cabecao uninstall --dry-run
O que "cabecao uninstall" tiraria desta máquina (nada foi feito):
  registro do servidor MCP no Codex: ~/.codex/config.toml
  registro do servidor MCP no Cursor: ~/.cursor/mcp.json
  skills do Cabeção em ~/.agents/skills (codex, cursor; só as que você não alterou)
  configuração da máquina: ~/.config/cabecao

Fica: o cérebro em ~/cabecao (é seu, está no git e no remoto). Apague a pasta à mão se quiser.
Para tirar o programa depois: npm uninstall -g cabecao
```

Para remover, rode sem `--dry-run`, no seu terminal. Ele mostra a mesma lista e pergunta:

```text
$ cabecao uninstall
Vai sair desta máquina:
  ...
Remover? [s/N] s
Pronto:
  registro removido do Codex
  registro removido do Cursor
  skills removidas de ~/.agents/skills
  apagado ~/.config/cabecao
O cérebro continua em ~/cabecao.
Para tirar o programa: npm uninstall -g cabecao
```

Só você confirma: sem terminal (um agente, um script), o comando recusa com o código 4. Depois, tire o programa com o comando que ele mostrou (`npm uninstall -g cabecao`, `pnpm remove -g cabecao` ou `/plugin uninstall cabecao@cabecao`). Para tirar também o cérebro desta máquina, apague a pasta dele; o remoto continua com tudo.

