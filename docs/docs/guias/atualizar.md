---
title: Atualizar o Cabeção
description: Atualize o programa, aplique as migrações do esquema do cérebro com cabecao upgrade e, se quiser, o modelo novo do AGENTS.md.
sidebar_position: 12
---

Atualizar tem duas partes: o **programa** (o pacote `cabecao`, o plugin do Claude Code, o pacote do Claude Desktop) e, de vez em quando, o **cérebro**, quando uma versão nova muda o formato dele.

## O programa

```bash
npm i -g cabecao@beta     # ou: npx cabecao@beta <comando>
```

O plugin do Claude Code se atualiza pelo marketplace, e o pacote do Claude Desktop, instalando o `.mcpb` novo por cima ([Claude Desktop](./claude-desktop.md)). Nenhum deles mexe no cérebro.

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
Sync: bloqueado. O cérebro no remoto foi atualizado para o esquema 2 por uma versão mais nova do Cabeção, e este Cabeção só entende até o 1. Nada do remoto foi aplicado e nada foi enviado; as mudanças desta máquina estão em commits locais. Atualize o Cabeção nesta máquina ("npm i -g cabecao@latest" ou "npx cabecao@latest") e rode o sync de novo.
Recebidos: 0 commits · enviados: 0 · criados neste sync: 1
Próximo passo: Atualize o Cabeção nesta máquina e rode sync de novo; até lá, as mudanças daqui ficam em commits locais e nada é enviado.
```

Uma mudança de esquema só sai em versão menor ou maior do pacote, nunca numa correção.

## O modelo do cérebro: `cabecao upgrade --template`

O `init` grava um `AGENTS.md` (as regras do cérebro para os agentes), um `CLAUDE.md`, um `.gitignore` e um `.gitattributes`. Versões novas do Cabeção às vezes melhoram esse modelo: o `AGENTS.md` das betas `0.1.0-beta.0` e `beta.1`, por exemplo, ainda manda gravar o handoff com `remember`, e hoje há a tool `handoff_save`. Esses arquivos são seus, então a atualização é **opcional e nunca passa por cima do que você editou**:

- um arquivo igual ao modelo de uma versão anterior (você nunca o editou) é trocado pelo atual;
- um arquivo que você editou mostra a diferença e pergunta; sem terminal (ou se você disser não), fica como está, e o modelo atual vai para `.cabecao/template/<arquivo>`, para você comparar e juntar à mão; `--yes` troca sem perguntar;
- no `.gitignore` e no `.gitattributes`, só acrescenta as linhas que faltam, no fim;
- um arquivo que não existe não é recriado;
- tudo num commit, que `cabecao undo --op <id>` desfaz.

O `cabecao status` avisa quando há atualização do modelo. Num cérebro criado pela beta:

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
