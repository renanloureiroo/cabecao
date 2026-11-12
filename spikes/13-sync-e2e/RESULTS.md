# Spike 13 — sync ponta a ponta: resultados

Execução: Node v24.21.0, git 2.54.0 (Apple Git-157), macOS arm64, 12/11/2026. Remoto simulado por repositório bare local; 2–3 clones fazem o papel das máquinas do mesmo usuário.
Tudo o que está marcado PROVADO foi executado por `node run-all.mjs` (170 de 170 verificações em 13 cenários, na última execução completa); a saída completa
está em `out/summary.txt` e `out/results.json`. O que não foi executado está na seção 5.

## 1. Vereditos

| # | Pergunta | Veredito | Em uma frase |
|---|---|---|---|
| Q1 | Worktree da branch órfã em `.cabecao/index/` | **DERRUBADO → substituído** | Funciona, mas tem 5 pontos fracos medidos. Substituído por: mesma branch, sem worktree, só plumbing. |
| Q2 | Algoritmo de sync completo, sem recálculo | **PROVADO** (com mudança) | 375 embeddings calculados = 375 chaves únicas em 3 máquinas; clone novo calcula 0. Exigiu enviar conteúdo e índice no mesmo push atômico. |
| Q3 | Conflitos de Markdown | **PROVADO** (estratégia nova) | `pull --rebase` e `merge` crus foram derrubados; merge em memória + cópia `.conflict-*` nunca trava o repo nem perde versão. |
| Q4 | `log.md` e `index.md` | **PROVADO** | `log.md merge=union`: 0 conflitos (contra 12/12 sem o atributo). `index.md` regenerado dentro do commit integrado: 0 conflitos. |
| Q5 | Concorrência local | **PROVADO** | 8 processos, 880 escritas, 36 syncs: 0 corrupção, 0 lock órfão. SQLite WAL com 2 escritores: 0 erros com `busy_timeout`. |
| Q6 | Morte no meio (SIGKILL) | **PROVADO** | 14 pontos determinísticos + 60 mortes aleatórias: o sync seguinte sempre se recupera sozinho. |
| Q7 | Compactação, órfãos, achatamento | **PARCIAL** | Compactação, descarte de órfãos e máquina offline: provados. Achatamento por force-push: derrubado como padrão (servidor pode proibir) e trocado por "gerações". Liberar espaço no provedor depende do provedor. |
| Q8 | Grafo exportado converge | **PROVADO** | `nodes.jsonl`, `edges.jsonl` e `manifest.json` idênticos byte a byte em A, B, clone novo e no remoto. |
| Q9 | Coexistência com Obsidian Git | **PROVADO** (simulado) | Commits/pulls por fora são detectados; reindexa só o delta; renomear/mover 3 notas recalcula 0 embeddings. Plugin real e celular não testados. |
| Q10 | Autenticação e remoto | **PARCIAL** | Detecções locais provadas (sem remoto, sem rede, sem permissão, público). Autenticação ssh real e provedores reais não testados. |
| Q11 | Tempo de sync | **PROVADO** (local) | Ocioso 0,5–0,7 s ms; 5 notas alteradas 1,1–1,8 s ms + embeddings; latência de rede só estimada. |
| B2 | Bootstrap só com a URL | **PROVADO** | Remoto vazio (main/master/trunk), cérebro existente, vault comum, repositório de código, erros e modo só local. |
| B3 | Provedores e plano B sem force-push | **PARCIAL** | Plano B (gerações) provado contra servidor que rejeita force-push e deleção. O comportamento dos provedores vem de documentação, não de teste. |
| B4 | Autenticação genérica sem terminal | **PROVADO** (http) | Sem TTY, credencial ausente vira erro em ~50 ms na sondagem e o sync inteiro termina em ~1 s; servidor travado é cortado pelo timeout. |
| B5 | Manutenção sem PR + undo | **PROVADO** | 1 commit por operação; `undo` em outra máquina, depois de sincronizado, restaura as notas byte a byte. |

### As quatro mudanças em relação ao desenho candidato

1. **Sem `git worktree`.** A branch `cabecao/index` continua existindo no mesmo repositório, mas é lida e escrita só
   com plumbing (`ls-tree`, `cat-file`, `hash-object`, `update-index` num índice descartável, `commit-tree`, `push`).
   Os arquivos ficam materializados em `.cabecao/index/` como cache comum, sem metadados de worktree.
2. **Sem rebase nem merge na árvore de trabalho.** O conteúdo é integrado em memória com `git merge-tree --write-tree`
   e aplicado com um único `git reset --keep`. Não existe estado "rebase pela metade" para sobrar.
3. **Conteúdo e índice no mesmo `git push --atomic`.** Na primeira versão (conteúdo primeiro, índice depois) o teste de
   estresse mostrou 2.789 embeddings calculados para 1.477 chaves: a outra máquina via o conteúdo antes dos vetores e
   recalculava. Com o push atômico o mesmo teste dá 1.536 calculados para 1.535 chaves (1.674 para 1.673 em outra execução; o total varia com o ritmo dos processos).
4. **Achatar = nova geração, não force-push.** `cabecao/index` → `cabecao/index-1` → `cabecao/index-2`… Cada geração
   nasce com 1 commit numa branch nova; a anterior é apagada depois. Funciona em servidor que proíbe non-fast-forward.

## 2. Por pergunta

### Q1 — Onde guardar os derivados

Cenário `scenarios/q01-alternativas.mjs`, git real em todos os casos.

**W: worktree da branch órfã (desenho candidato).** Funciona: `git worktree add --orphan -b cabecao/index .cabecao/index`
(git ≥ 2.42), `git status` do main limpo, `git add -A` não adiciona nada, bootstrap de clone novo com 1 comando,
segmentos imutáveis concorrentes passam em `pull --rebase` sem conflito. Pontos fracos medidos:

| # | Ponto fraco | Evidência |
|---|---|---|
| 1 | Clone `--single-branch` não tem a branch | `fatal: invalid reference: cabecao/index` até ajustar o refspec e buscar |
| 2 | Arquivo mutável na branch (manifesto, grafo) conflita no rebase | worktree fica com `.git/worktrees/index/rebase-merge` e `UU manifest.json` |
| 3 | Mover ou renomear a pasta do vault quebra o worktree | `fatal: not a git repository`; `git worktree repair` sozinho não conserta, só `git worktree repair <caminho>` |
| 4 | Apagar `.cabecao/` impede recriar o worktree | falha até rodar `git worktree prune` |
| 5 | Sem a linha `.cabecao/` no `.gitignore`, o `git add -A` do plugin adiciona um gitlink | `160000 … .cabecao/index` no índice do main |

Não se confirmou um sexto ponto que eu esperava: depois de um achatamento por force-push, `pull --rebase` na outra
máquina reaplicou só o commit local (o git usa o reflog). `git clean -fdx` também não apaga o worktree, mas apaga
`.cabecao/local/query.db`.

**Alternativas.**

| Alternativa | Resultado | Ponto fraco medido |
|---|---|---|
| (a) derivados no `main` | Derrubada | Duas máquinas editam notas diferentes e o pull do conteúdo para em conflito em `.cabecao/manifest.json`. 2 de 2 commits carregam binários; clone de 1.997 KB contra 43 KB só de conteúdo; não dá para achatar sem reescrever o histórico do conteúdo. |
| (b) segundo repositório | Funciona | Clone novo não sabe a segunda URL: sem ela recalculou os 140 trechos. Sync ocioso custa 2 idas ao remoto em vez de 1. Não há push atômico conteúdo + índice. Contraria "o usuário informa apenas a URL". |
| (c) ref fora de `refs/heads` + plumbing | Funciona em git puro | Clone comum não baixa o índice (43 KB contra 1.859 KB), sobrevive a `fetch --prune` e `gc`, entra em `clone --mirror`. Mas nenhum provedor documenta aceitar essas refs (ver B3). |
| (d) git notes | Derrubada | 35–54 ms por vetor (6–9 min para 10.000) contra 1,3 ms para um segmento com 300. `.git` cresce 352 KB para 117 KB de dados. `notes add -F` corrompe binário (384 → 385 bytes). Mesma chave nas duas máquinas: `git notes merge` para em conflito com estado próprio. |
| **(P) branch comum + plumbing, sem worktree** | **Escolhida** | Clone comum baixa o índice (1.859 KB no teste; 4–8 MB num vault real). |

A escolhida (P) passou nos mesmos testes: 0 recálculos na segunda máquina, 1 ida ao remoto no sync ocioso, autocura
depois de apagar `.cabecao/` e rodar `gc --prune=now`, e mover a pasta do vault não quebra nada. A ref é
configurável: o mesmo código rodou com `refs/cabecao/index` (variante c) e com um segundo remoto (variante b).

### Q2 — Algoritmo de sync completo

Cenário `q02-sync-algoritmo.mjs`, 3 máquinas, embedding simulado com contador por máquina.

| Passo | Embeddings calculados |
|---|---|
| A indexa 50 notas (350 trechos) | A: 350 |
| B, clone novo, faz bootstrap | B: 0 (2 segmentos materializados) |
| B edita 5 parágrafos e cria 2 notas | B: 13; depois A: 0 |
| A e B criam notas diferentes ao mesmo tempo | A: 5, B: 5; depois A: 0. B integrou por replay, sem commit de merge |
| Mesmo texto criado nas duas; A sincroniza primeiro | A: 2, B: 0 |
| C, clone do zero | C: 0, índice completo e correto (372 trechos, 0 vetores faltando ou errados) |

Total no mundo: **375 calculados = 375 chaves únicas** (A 357, B 18, C 0). As três máquinas terminam no mesmo commit
e com o mesmo conjunto de segmentos.

Exceção conhecida, medida no Q5: texto idêntico criado em duas máquinas antes de qualquer uma enviar é calculado nas
duas (1 repetição em 1.536).

### Q3 — Conflitos de conteúdo

Cenário `q03-conflitos.mjs`.

| Estratégia | Resultado |
|---|---|
| `git pull --rebase` | Derrubada. Para no conflito com `.git/rebase-merge`, HEAD destacado e `<<<<<<<` dentro da nota. Se o processo morrer aí, o repo fica assim. |
| `git merge` com marcadores | Derrubada. Marcadores dentro do frontmatter (`tags: [a] ⏎ <<<<<<< HEAD ⏎ status: publicado ⏎ =======`): YAML inválido, `MERGE_HEAD` pendente. |
| Merge automático em regiões diferentes | Funciona quando há pelo menos 1 linha intacta entre as edições: frontmatter (A) × corpo (B) fundiu limpo, por replay. Linhas adjacentes do frontmatter (`tags` e `status`) conflitam. |
| **Merge em memória + preservar os dois lados** | **Escolhida.** |

Comportamento provado da escolhida:

- Conflito real: o sync termina sozinho. `x.md` fica com a versão remota; `x.conflict-B-<data>.md` fica com a versão
  local. Sem marcadores, árvore limpa, tudo enviado. A outra máquina recebe por fast-forward e converge byte a byte.
- O commit de merge tem dois pais: nenhum commit local é reescrito, então a versão local também fica no histórico.
- Três commits locais na mesma nota contra uma edição remota geram uma única cópia, com a última versão local.
- Editado × apagado: a edição vence, nos dois sentidos.
- Mesma edição nos dois lados: sem conflito.
- Nota salva durante o sync (Obsidian aberto): `reset --keep` recusa (`Entry 'wiki/x.md' not uptodate`), o sync
  commita a edição e refaz o ciclo. Nada é sobrescrito.
- Operação alheia em andamento (rebase que outro cliente deixou): o Cabeção não toca no conteúdo e sincroniza só o
  índice. Com `autoAbortStale`, faz `rebase --abort` e conclui preservando os dois lados.

Como o repo nunca fica em rebase pela metade: o Cabeção nunca inicia rebase nem merge na árvore de trabalho. Tudo
antes do `reset --keep` são objetos soltos; morrer ali não muda nada. Morrer durante o `reset --keep` deixa arquivos
parcialmente atualizados, que o sync seguinte commita e funde de novo (provado no Q6, ponto `before-reset`/`after-reset`).

### Q4 — `log.md` e `index.md`

Cenário `q04-append-only.mjs`, 12 rodadas de escrita concorrente por caso.

| Caso | Conflitos |
|---|---|
| `log.md` sem atributo, git puro | 12/12 |
| `log.md merge=union` no `.gitattributes` versionado, sync do Cabeção | 0/12; 24 linhas, cada uma 1 vez, sem marcadores |
| idem, com `git pull` puro (merge e rebase) | 0 |
| `index.md` versionado, git puro, nomes distantes (`a*`, `b*`) | 1/12 |
| `index.md` versionado, git puro, nomes vizinhos (mesmo prefixo de data) | 12/12 |
| `index.md merge=union` | 0, mas mantém link para nota apagada (índice errado em silêncio) |
| `index.md` tratado como derivado pelo Cabeção | 0/12, 0 cópias de conflito, sempre igual ao gerado da árvore, histórico linear |

Detalhes que importam:

- O driver `union` é nativo: clone novo não tem nenhuma configuração local de merge.
- Limite do `union`: se as duas máquinas editam a mesma linha existente, as duas versões ficam (duplica, não perde).
  A ordem das linhas é a da integração, não a do relógio.
- `merge-tree` lê `.gitattributes` da árvore de trabalho. Se o arquivo sumir de lá, o `union` deixa de valer
  (exit 1); com `git --attr-source=<commit>` volta a valer (exit 0). O sync passa `--attr-source` nesse caso.
- Nota criada por cliente sem Cabeção (celular): o próximo sync acrescenta 1 commit que regenera `index.md`.

Recomendação: `log.md` continua no `main` com `merge=union`. `index.md` continua no `main` (para ser lido no Obsidian
e por clientes sem Cabeção), mas é sempre regenerado dentro do commit integrado e nunca gera cópia de conflito.

### Q5 — Concorrência local

Cenário `q05-concorrencia.mjs`. Na máquina A: 3 processos escritores e 3 processos de sync em laço. Na máquina B:
1 escritor e 1 sync. Ao todo 8 processos simultâneos,
880 notas escritas, 880 linhas de log, 36 syncs, 23 s. Durante a execução: 2 rejeições de push resolvidas, 2.177 esperas
pelo lock, 0 locks roubados, 1 repetição por `.lock` do git, maior sync 7 s.

- As 440 notas existem com o conteúdo final exato em A, B e num clone novo.
- `log.md` tem as 880 linhas, cada uma 1 vez, nenhuma rasgada.
- Nenhum `index.lock` ou `*.lock` do git, nenhum lock do Cabeção, nenhum rebase pendente, nenhum temporário.
- `git fsck` ok nos 3 clones e no remoto; `PRAGMA integrity_check` ok; todo trecho com vetor correto.
- Embeddings: 1 repetição no total (o trecho idêntico `FIM`, criado nas duas máquinas antes de qualquer envio).

Lock: `mkdir` atômico com `owner.json` (pid, host, início do processo). Lock de PID inexistente é tomado em 1 ms.
Exclusão mútua: 6 processos × 200 incrementos ler-modificar-gravar = 1.200, nenhuma atualização perdida. São dois
locks: `sync.lock` (um sync por vez, pode durar segundos) e `worktree.lock` (curto, em volta do `rename` de uma nota
e do `add`/`commit`/`reset` do sync), para que escrever uma nota não espere um sync inteiro.

SQLite `node:sqlite` em WAL: 2 processos gravando tabela + FTS5 e 1 lendo ao mesmo tempo, 6.000 linhas,
`integrity_check` ok, 0 erros com `busy_timeout=15000`. Controle com `busy_timeout=0`: milhares de `SQLITE_BUSY`
(1.697 + 1.424 na última execução). `busy_timeout` e `BEGIN IMMEDIATE` são obrigatórios.

### Q6 — Morte no meio

Cenário `q06-morte-subita.mjs`.

- **Pontos determinísticos.** SIGKILL em 14 pontos: `after-autocommit`, `after-fetch`, `before-reset`, `after-reset`,
  `mid-materialize`, `after-integrate-index`, `after-embed-before-segment`, `after-segment-before-db`,
  `after-compact-write`, `after-compact-unlink`, `after-index-commit`, `after-index-push`, `after-push-main`,
  `after-index-sync`. Todos foram atingidos; o sync seguinte concluiu em todos, sem lock nem estado pendente.
- **Instantes aleatórios.** 60 mortes (30 só o processo node, 30 o grupo inteiro, incluindo os git filhos), em
  instantes sorteados dentro da duração de um sync. Todos os syncs de verificação intermediários concluíram. Nessa
  execução nenhuma morte deixou `index.lock` órfão; esse caminho foi exercitado à parte (abaixo).
- **Estado final.** As 148 notas escritas entre as mortes estão idênticas em A, B e num clone novo. Mesmo commit e
  mesmos segmentos nas três. Nenhum `*.lock`, rebase, lock do Cabeção ou temporário. `git fsck` ok em A, B e no
  remoto. Embeddings: 666 calculados para 662 chaves, ou seja, 4 desperdiçados em 74 mortes.
- **Arquivos parciais.** Segmento local truncado e segmento com bytes trocados: descartados pelo checksum (2).
  Segmento conhecido do remoto truncado no disco: restaurado do git (1). `query.db` substituído por lixo: apagado e
  reconstruído (`file is not a database`). Nos três casos, 0 embeddings recalculados.
- **`index.lock` do git.** Órfão antigo: removido no início do sync. Recente (pode ser outro git trabalhando): o
  sync espera e repete; só remove depois do limite de idade (1,5 s no teste; 30 s por padrão).

Custo de uma morte: no máximo o lote de embeddings que estava em memória (lotes de 256). A ordem que garante isso é
gravar primeiro o segmento (tmp + fsync + rename) e só depois o SQLite.

### Q7 — Compactação, órfãos e achatamento

Cenário `q07-compactacao.mjs` e simulação `harness/growth.mjs`.

**Três máquinas, uma offline.** C fica sem remoto, edita e indexa localmente (5 trechos na fila). A e B fazem 18
rodadas de edição: 7 compactações pequenas, 7 totais, 525 chaves órfãs descartadas, no máximo 4 segmentos, 1 troca
de geração no meio. Quando C volta, troca os segmentos antigos pelos atuais, envia o que estava na fila e calcula
0. Em toda a história, 756 embeddings calculados = 756 chaves únicas.

- Compactação concorrente dos mesmos segmentos em A e B gera o mesmo arquivo (mesmo nome), sem conflito nem duplicata.
- Órfãos são removidos: depois da compactação total, 210 chaves nos segmentos = 210 chaves em uso.
- Órfãos só são descartados por quem está em dia com o conteúdo remoto; quem está offline ou atrasado compacta sem descartar.

**Crescimento em 6 meses.** 2.000 notas × 5 trechos = 10.000 vetores; 60 vetores novos por dia (os 60 antigos viram
órfãos); 3 syncs por dia alternando 2 máquinas; vetores aleatórios (não comprimem). 541 commits na ref.

| Vetor | Achatamento | Dados vivos | Remoto antes do GC do servidor | Remoto depois do GC | Clone novo |
|---|---|---|---|---|---|
| 384d | nenhum | 4,0 MB | 29,8 MB | 29,8 MB | 29,8 MB |
| 384d | force-push a cada 30 dias | 4,0 MB | 29,8 MB | 4,0 MB | 4,0 MB |
| 384d | gerações a cada 30 dias | 4,0 MB | 29,4 MB | 4,0 MB | 4,0 MB |
| 768d | nenhum | 7,8 MB | 57,7 MB | 57,7 MB | 57,7 MB |
| 768d | force-push a cada 30 dias | 7,8 MB | 57,8 MB | 7,8 MB | 7,8 MB |
| 768d | gerações a cada 30 dias | 7,8 MB | 57,2 MB | 7,8 MB | 7,8 MB |
| 384d | gerações, servidor nega force-push | 4,0 MB | 30,1 MB | 4,0 MB | 4,0 MB |
| 384d | force-push, servidor nega force-push | 4,0 MB | 29,9 MB | 29,9 MB | 29,9 MB (6 de 6 achatamentos rejeitados) |

Leitura: o histórico cresce cerca de 4,3 MB por mês em 384d e 8,3 MB por mês em 768d nesse ritmo de uso. Achatar só
reduz o que um clone novo baixa de imediato; o espaço no servidor só cai quando o servidor coleta o lixo. No clone
local o espaço volta depois de `git gc` e da expiração do reflog (29,5 MB → 4,0 MB medido com `--prune=now`).
Em todas as configurações, nenhuma chave viva foi perdida e as duas máquinas terminaram com os mesmos segmentos.

Observação: a primeira execução de 768d/gerações abortou com um push rejeitado seguido de falha de fetch não
classificada, numa versão anterior do código de drenagem e com 8 simulações em paralelo. Não diagnostiquei a causa.
A reexecução isolada com o código final passou (resultado na tabela).

**Force-push libera espaço no GitHub?** Não testado. Pela documentação, não de forma garantida (ver B3).

### Q8 — Grafo exportado

Cenário `q08-grafo.mjs`. Seis rodadas de edições concorrentes com notas novas, links, renomeação, remoção e nomes
acentuados. Resultado: `graph/nodes.jsonl`, `graph/edges.jsonl` e `manifest.json` com o mesmo sha256 em A, B, num
clone novo e na ref remota (42 nós, 44 arestas). Apagar o `query.db` e reconstruir do zero dá os mesmos bytes do
caminho incremental, com 0 embeddings recalculados.

A regra "regenerar depois de integrar" funciona com duas condições: só escreve o export quem está em dia com o
conteúdo, e o `manifest.json` guarda o commit de conteúdo de origem (export de commit descendente vence). Na corrida
testada (B envia entre o fetch e o push de A), o push atômico de A é rejeitado, A refaz o ciclo e o manifesto remoto
fica igual ao commit de conteúdo remoto.

Isso vale para o grafo barato (wikilinks). Se o grafo vier de extração cara (LLM), o resultado da extração por nota
deve ser guardado como os embeddings: chaveado pelo hash do conteúdo, em arquivos imutáveis. Não testei esse caso.

### Q9 — Coexistência com Obsidian Git

Cenário `q09-obsidian-git.mjs`. O plugin foi simulado com `git add -A`, `commit`, `pull --no-rebase`, `push` feitos
por fora do Cabeção.

- `git add -A` não enxerga `.cabecao/` (`!! .cabecao/` em `status --ignored`).
- `git diff --name-status -M` do último commit indexado até o HEAD mostra as renomeações:
  `R100 wiki/n0002.md → memory/sub/movida.md`, `R100 wiki/n0001.md → wiki/renomeada.md`,
  `R096 wiki/n0003.md → wiki/renomeada-e-editada.md`, `D wiki/n0004.md`, `M wiki/n0005.md`.
- O sync reindexa só o delta (8 caminhos de 39 notas) e calcula **1** embedding: o parágrafo editado. Renomear,
  mover de pasta e mexer só no frontmatter calculam 0. A outra máquina recebe com 0.
- Histórico local com commit de merge do plugin: o Cabeção não reescreve nada, integra com merge e envia.
- `git fetch --prune`, `gc --prune=now`, `stash -u`, `clean -fd` no main: índice intacto.
- `git clean -fdx` apaga `.cabecao/` inteiro; o sync seguinte rematerializa os 6 segmentos e reconstrói o SQLite com
  0 recálculos.

A renomeação é gratuita porque a chave do trecho é o hash do texto + spec do modelo e não inclui o caminho nem o
título. Se o produto decidir prefixar o trecho com o título da nota, renomear passa a recalcular.

### Q10 e B4 — Remoto e autenticação

Cenário `q10-remoto-auth.mjs`, com servidores HTTP locais de teste.

O sync assume só o que o git do usuário já usa: chave no ssh-agent, credential helper, token no helper. Ele nunca
pergunta nada. Todo comando git roda com `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=true`, `SSH_ASKPASS=true`,
`SSH_ASKPASS_REQUIRE=never`, `GCM_INTERACTIVE=never`, `GIT_SSH_COMMAND="ssh -oBatchMode=yes -oConnectTimeout=10"` e
timeout por operação remota (60 s por padrão).

Detecção com 1 `git ls-remote --symref <url>`:

| Situação | Classificação | Tempo | Mensagem do git |
|---|---|---|---|
| http anônimo que responde | ok, branch padrão e branch de índice detectadas | ~60 ms | |
| http 401 | `auth` | ~50 ms | `fatal: Authentication failed for 'http://127.0.0.1:…/repo.git/'` |
| host não resolve | `no-network:dns` | ~140 ms | `Could not resolve host` |
| porta fechada (http e ssh) | `no-network:connect` | ~35 ms | `Failed to connect to 127.0.0.1 port …` |
| servidor aceita e nunca responde (http e ssh) | `no-network:connect` | 4.000 ms (timeout do teste) | `cabecao: operation timed out after 4000 ms` |
| caminho inexistente | `not-found` | ~30 ms | |
| sem remoto configurado | `noRemote` (sem ida ao remoto) | | |

Sem terminal: controle com pseudo-terminal mostra o git cru parado em `Username for 'http://127.0.0.1:…':` até ser
morto. Com o ambiente acima, o processo de sync iniciado sem TTY (stdin fechado, sessão nova) contra o mesmo
servidor termina sozinho em 0,9–1,3 s (processo inteiro, incluindo indexar a nota), classifica `auth`, e ainda commita
e indexa localmente. Contra o servidor travado termina em 4,8–5,4 s (timeout de 4 s no teste). Quando o remoto volta, os 5 commits e os segmentos da fila são enviados de uma vez e a
outra máquina recebe com 0 recálculos.

"Remoto público?" sem `gh` nem API: só é verificável em URL http(s), tentando ler sem credenciais
(`git -c credential.helper= ls-remote`). Respondeu: público. 401: privado ou inexistente. Em ssh ou caminho local
não há como saber; o Cabeção só pode avisar. Provado contra os servidores locais.

Não testado: falha de autenticação ssh real (não há servidor ssh de teste), credential helpers reais, qualquer
provedor. O classificador reconhece amostras de mensagens conhecidas de GitHub, GitLab e Bitbucket, mas essas
amostras foram coladas no teste, não geradas.

### Q11 — Tempo de sync

Cenário `q11-tempos.mjs`, vault de 2.000 notas (14.000 trechos), remoto local, embedding simulado com custo zero.

| Operação | Tempo | Processos git | Idas ao remoto |
|---|---|---|---|
| Sync ocioso | mediana 691 ms (644–736); 457 ms numa execução isolada | 25 | 1 (`ls-remote`) |
| Sync típico, 5 notas alteradas (10 trechos novos) | mediana 1.781 ms (1.681–1.903); 1.108 ms numa execução isolada | 57 | 2 (`ls-remote` + push atômico) |
| Receber na outra máquina (45 notas alteradas, 9 segmentos novos) | 1.695 ms, 0 recálculos | não medido | 2 |
| Bootstrap de máquina nova, 2.000 notas | 1.719 ms, 0 recálculos | não medido | não medido |
| Primeiro sync de 2.000 notas | 5.248 ms (conteúdo 1.437, índice 3.810) | não medido | não medido |

Com rede real (não medido), cada ida ao remoto custa da ordem de 0,3–1,2 s. Dá para rodar no fim de cada sessão: o
ocioso deve ficar em 1–2 s e o típico em 2–4 s mais o tempo real dos embeddings. O número de processos git por
sync é alto e pode ser reduzido; não otimizei.

### B2 — Bootstrap só com a URL

Cenário `b2-bootstrap.mjs`, módulo `lib/bootstrap.mjs`.

| Caso | Resultado |
|---|---|
| (a) remoto vazio, branch padrão `main`, `master` e `trunk` | Cria estrutura, primeiro commit, branch de índice e envia. A branch padrão vem do `git clone` do repositório vazio, não é assumida. |
| (b) remoto já é um cérebro (branch `trunk`) | `joined`: clona, materializa o índice, 0 embeddings (a primeira máquina tinha calculado 120). |
| (c) vault Obsidian comum (branch `master`, pastas próprias, `index.md` feito à mão) | `adopted`: acrescenta só `.cabecao.json` e `.gitignore`; nenhum arquivo existente muda; `index.md` do usuário é preservado; 3 notas em qualquer pasta indexadas. A segunda máquina entra como `joined` com 0 recálculos. |
| (d) repositório de código | `refused`: não deixa pasta local nem toca no remoto. Mensagem lista a evidência (1 `.md` de 4 arquivos, `package.json`, 2 arquivos de código). |
| (e) caminho inexistente, host que não resolve, texto que não é URL | Erro claro, nada criado (`not-found`, `no-network:dns` em 0,06–0,15 s). |
| (e) modo só local | Funciona sem remoto. Remoto vazio adicionado depois: envia tudo; outra máquina entra com 0 recálculos. Remoto que já tem conteúdo: recusado. |

A detecção de "é um cérebro" usa o arquivo versionado `.cabecao.json` ou a presença da branch de índice. A de
"é um vault" é heurística (pasta `.obsidian/` ou ≥ 80% de Markdown e anexos, sem marcadores de código).

### B3 — Provedores e plano B sem force-push

**Plano B provado** (`q07-compactacao.mjs`, parte B), contra bare com `receive.denyNonFastForwards=true` e
`receive.denyDeletes=true`, e depois com hook `pre-receive` que proíbe reescrita e remoção:

- Force-with-lease é rejeitado (`denying non-fast-forward refs/heads/cabecao/index`). O sync continua normal.
- Girar para `cabecao/index-1` é aceito; o histórico volta a 1 commit. A branch antiga, que o servidor não deixa
  apagar, fica lá sem efeito e sem tentativas repetidas (sync ocioso continua com 1 ida ao remoto).
- A outra máquina adota a geração nova sozinha, com 0 recálculos.
- Com deleção permitida, a geração anterior é apagada na troca seguinte.
- Corrida: B envia um segmento para a geração velha depois de A girar. O segmento é drenado para a geração atual,
  ninguém recalcula, e um clone novo fica completo.

**Documentação dos provedores.** Pesquisa feita por um subagente em páginas oficiais; não conferi cada citação.

| | GitHub | GitLab.com | Bitbucket Cloud | Gitea / Codeberg |
|---|---|---|---|---|
| Proteção por padrão | Nenhuma documentada; só por regra criada | Branch padrão protegida, sem force-push | Nenhuma documentada | Nenhuma documentada |
| Force-push e deleção em branch não protegida | Não documentado (inferido: permitido) | Não documentado (inferido: permitido) | Não documentado | Não documentado |
| Refs fora de `refs/heads` | Só `refs/pull/` documentada como reservada | Namespaces internos reservados; demais não documentado | Não documentado; maior risco | `refs/pull` reservada; demais inferido |
| Limite de arquivo | Aviso > 50 MiB, bloqueio > 100 MiB | Não encontrado; push ≤ 5 GiB | Bloqueio ≥ 100 MB | Não listado |
| Limite de repositório | 10 GB recomendado | 10 GiB no plano gratuito | 4 GB por repo; 1 GB por workspace gratuito | Codeberg: pedir acima de 750 MiB |
| Coleta de objetos inalcançáveis | Sem agenda documentada; só o suporte dispara | Housekeeping; poda com prazo de 2 semanas, ou manual | Sem gatilho do usuário; automática só acima do limite | Cron de `git gc` desligado por padrão; Codeberg ~30 dias |

Fontes: [GitHub: protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches),
[GitHub: large files](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github),
[GitHub: repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits),
[GitHub: removing sensitive data](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository),
[GitLab: protected branches](https://docs.gitlab.com/user/project/repository/branches/protected/),
[GitLab: default branch](https://docs.gitlab.com/user/project/repository/branches/default/),
[GitLab: housekeeping](https://docs.gitlab.com/administration/housekeeping/),
[GitLab: repository size](https://docs.gitlab.com/user/project/repository/repository_size/),
[Bitbucket: branch permissions](https://support.atlassian.com/bitbucket-cloud/docs/use-branch-permissions/),
[Bitbucket: reduce repository size](https://support.atlassian.com/bitbucket-cloud/docs/reduce-repository-size/),
[Gitea: protected branches](https://docs.gitea.com/usage/access-control/protected-branches),
[Gitea: config cheat sheet](https://docs.gitea.com/administration/config-cheat-sheet),
[Codeberg FAQ](https://docs.codeberg.org/getting-started/faq/).

Padrão mais portável: **branch comum + gerações, sem force-push**. Usa só criar branch, push fast-forward e apagar
branch, que todo servidor git aceita por padrão. Como a coleta de lixo no servidor é incerta, trocar de geração
raramente: o espaço pode nunca voltar. Segmentos ficam bem abaixo de 50 MiB (o maior da simulação tem ~4 MB em
384d). Uma ref fora de `refs/heads` fica como opção, só depois de um teste de capacidade no servidor.

Duas consequências práticas da branch comum: não pode existir uma branch chamada `cabecao` (conflito de nome de
ref), e em servidores com CI configurado para toda branch convém excluir `cabecao/*`.

### B5 — Manutenção sem PR

Cenário `b5-undo.mjs`.

- `maintenance(op, fn)`: edições pendentes do usuário vão num commit separado; a operação grava 1 commit
  `cabecao(maint): <op>` com os trailers `Cabecao-Op`, `Cabecao-Machine` e `Cabecao-Restore`.
- Antes da operação, cria `refs/cabecao/restore/<data>-<op>` local (não vai para o remoto, não vira tag).
- `undo()`: commit novo de reversão, calculado em memória, com trailer `Cabecao-Undo: <commit>`. Não reescreve histórico.

Provado: a manutenção (juntar 2 notas, apagar as originais, alterar uma terceira) é sincronizada; as duas máquinas
continuam editando; o `undo` é executado **na outra máquina**. As notas apagadas voltam idênticas byte a byte, a
consolidada sai, as edições posteriores são preservadas (inclusive na nota que a manutenção alterou, em outra
região), `index.md` fica coerente, e a primeira máquina recebe por fast-forward. Um segundo `undo` responde "nenhuma
manutenção para desfazer". Se alguém editou depois exatamente a linha que a manutenção mudou, a versão atual fica e
a versão restaurada vira cópia `.conflict-*`.

Nesse teste nenhum embedding foi recalculado no `undo`, mas a compactação estava desligada. Com descarte de órfãos
ativo, desfazer uma manutenção antiga pode recalcular os trechos cujos vetores já foram descartados.

Recomendação: commit por operação + `undo` por reversão como mecanismo principal. O ponto de restauração local é
barato e serve de rede de segurança; não usar tags (poluem a lista de tags e vão para o remoto).

## 3. Especificação recomendada do sync

### Layout

```
<vault>/                      branch padrão do remoto (main, master, trunk…): só conteúdo
  .cabecao.json               versionado: { schema, noteDirs, indexMd }
  .gitignore                  contém ".cabecao/"
  .gitattributes              "log.md merge=union"
  AGENTS.md  index.md  log.md
  raw/  wiki/  memory/        (vault adotado: noteDirs = ["."], nada é movido)
  .cabecao/                   ignorado pelo git
    index/                    cache materializado da branch de índice
      embeddings/<spec>/seg-<24 hex>.bin
      graph/nodes.jsonl  graph/edges.jsonl
      manifest.json
    local/                    query.db (SQLite WAL: FTS5, vetores, chaves por segmento), sync.lock, worktree.lock
    tmp/                      temporários (mesmo filesystem, para o rename ser atômico)

Remoto:
  refs/heads/<padrão>                 conteúdo
  refs/heads/cabecao/index[-<n>]      índice; vale a geração de maior n

Refs locais (sem reflog, fora de refs/heads):
  refs/cabecao/remote    última ponta do índice buscada
  refs/cabecao/base      última ponta do índice integrada no disco
  refs/cabecao/local     último commit de índice criado aqui
  refs/cabecao/restore/* pontos de restauração de manutenção
```

### Formato do segmento

```
0   "CBSG"            4 bytes
4   versão            u8 (1)
5   tamanho da chave  u8 (16)
6   dimensão          u16 LE
8   nº de registros   u32 LE
12  tamanho do spec   u16 LE
14  spec              UTF-8
    registros         n × (chave[16] + vetor int8[dim]), ordenados pela chave
    sha256            32 bytes, de tudo que veio antes
```

- Chave = primeiros 16 bytes de `sha256(spec + "\n" + texto do trecho)`. Não inclui caminho nem título.
- Nome = `seg-<24 hex do sha256 do arquivo>.bin`. Conteúdo igual dá nome igual.
- Sem data nem identificador de máquina dentro do arquivo: a compactação é determinística.
- Escrita: tmp + fsync + rename. Leitura: confere tamanho, sha256 final e nome.

### Algoritmo, passo a passo

1. Adquirir `sync.lock`. Limpar `*.lock` do git mais velhos que o limite e temporários de processos mortos.
2. Se o HEAD está destacado ou há rebase/merge/cherry-pick em andamento: não tocar no conteúdo; seguir só com o índice.
3. Sob `worktree.lock`: `git add -A`, regenerar `index.md`, `git commit` (se houver algo).
4. `git ls-remote <remoto> refs/heads/<branch> 'refs/heads/cabecao/index*'`. Se algo mudou, um único `git fetch`
   das duas refs (retrato consistente). Falha: classificar e seguir offline.
5. Integrar o conteúdo em memória:
   - remoto é ancestral do HEAD: nada a fazer;
   - HEAD é ancestral do remoto: alvo = remoto;
   - divergiu: reaplicar os commits locais sobre o remoto com `merge-tree --merge-base` (histórico linear). Se houver
     conflito real ou commit de merge no trecho local: um commit de merge de dois pais, com as cópias de conflito.
   - Em qualquer árvore resultante, `index.md` é regenerado.
6. Sob `worktree.lock`: `git reset --keep <alvo>`. Se recusar (arquivo sendo editado), voltar ao passo 3.
7. Integrar o índice por nomes de arquivo:
   - está no remoto e falta no disco: materializar;
   - está no disco, não no remoto, estava na base: outra máquina compactou; apagar do disco;
   - está no disco, não no remoto, não estava na base: é local; entra no próximo commit;
   - arquivo local com checksum inválido: descartar.
8. Carregar no SQLite os segmentos novos; esquecer os que sumiram.
9. Reindexar o delta `git diff --name-status <último indexado>..HEAD` (ou tudo, se o commit indexado não existe mais).
10. Para cada chave em uso que não está em nenhum segmento atual: usar o vetor do cache local se houver; senão
    calcular. Gravar em lotes: primeiro o segmento, depois o SQLite.
11. Compactar se a política pedir. Descartar órfãos só se o HEAD contém tudo o que o remoto tem de conteúdo.
12. Criar o commit de índice (pai = ponta remota; árvore = remoto ∪ locais novos − compactados + grafo e manifesto).
13. `git push --atomic <remoto> <commit índice>:<ref de índice> <HEAD>:refs/heads/<branch>`. Rejeitado: voltar ao
    passo 3. Sem nada novo no índice: enviar só o conteúdo.
14. Se a contagem de commits da ref de índice passou do limite: criar a próxima geração.
15. Gravar o export do grafo em `.cabecao/index/`. Liberar o lock.

### Conflitos

- Caminho original fica com a versão remota; `<nome>.conflict-<máquina>-<data>.<ext>` fica com a versão local.
- Editado × apagado: a edição vence.
- `index.md`: nunca conflita, é regenerado. `log.md`: `merge=union`.
- O sync devolve a lista de conflitos para o cliente MCP mostrar ao usuário ou ao agente.

### Locks e escrita

- `sync.lock` e `worktree.lock` por `mkdir` atômico, com dono (pid, host, início do processo). Dono morto é
  detectado e o lock é tomado sob um mutex de roubo.
- Notas escritas pelo Cabeção: tmp em `.cabecao/tmp/` + `rename` sob `worktree.lock`.
- SQLite: WAL, `busy_timeout`, `BEGIN IMMEDIATE`. O banco é cache: se corromper, apaga e reconstrói.
- Git: `GIT_OPTIONAL_LOCKS=0`; repetir quando outro processo segura um `.lock`.

### Compactação e gerações

- Dois níveis: segmentos pequenos (< 1.000 registros) são fundidos ao chegar a 12; tudo é fundido quando a fração
  morta (órfãos + duplicatas) passa de 25% ou há mais de 4 segmentos grandes.
- Nova geração: commit raiz com a mesma árvore, enviado para `cabecao/index-<n+1>` (branch nova, sem force). A
  mensagem do commit registra a ref e o commit de origem.
- Toda máquina que vê uma geração antiga no remoto busca os arquivos que só existem nela, inclui na atual e depois
  apaga a antiga com `--force-with-lease` (só apaga se ninguém escreveu nela desde então). Servidor que proíbe
  apagar: a ref fica, registrada localmente para não tentar de novo.
- Cadência sugerida: trocar de geração quando o histórico passar de umas 10 vezes os dados vivos, ou uma vez por
  ano. É um palpite a partir da tabela do Q7, não um limiar testado.

### Bootstrap de máquina nova

1. `git ls-remote --symref <url>`: classifica erro, vazio ou com conteúdo; descobre a branch padrão.
2. Vazio: `git clone`, criar a estrutura, primeiro sync (envia conteúdo e índice).
3. Com conteúdo: `git clone --no-checkout`, classificar a árvore (cérebro, vault, outra coisa). Outra coisa: apagar
   a pasta e recusar. Vault: acrescentar `.cabecao.json` e a linha no `.gitignore`.
4. Primeiro sync: materializa os segmentos, reconstrói o SQLite com reindexação completa, calcula só o que faltar.

## 4. Decisões que ficam com o dono do projeto

- **Branch comum ou ref fora de `refs/heads`.** A branch é portável e visível; o clone comum (inclusive no celular)
  baixa o índice. A ref customizada esconde o índice dos clientes comuns, mas depende de o servidor aceitar.
- **Hooks e assinatura.** Os commits automáticos usam `--no-verify`. Assinatura de commits (`commit.gpgsign`) não
  foi testada e pode pedir senha num processo sem terminal.
- **`autoAbortStale`.** Abortar sozinho um rebase que outro cliente deixou pela metade destrava o repo, mas descarta
  uma resolução manual em andamento. Está desligado por padrão na PoC.

## 5. O que não foi testado

| Item | Por quê |
|---|---|
| Qualquer provedor real (GitHub, GitLab, Bitbucket, Gitea) | Restrição da tarefa: nenhum repositório remoto criado |
| `git push --atomic` em servidor sem suporte | O bare local suporta; o caminho alternativo (índice primeiro, conteúdo depois) existe no código e só foi exercitado na variante de segundo repositório |
| Liberação de espaço no servidor depois de trocar de geração | Depende do provedor; só medido com `git gc --prune=now` no bare local |
| Autenticação ssh com falha de chave, credential helpers reais | Não há servidor ssh de teste; não instalei software |
| Plugin Obsidian Git real e clientes de celular (isomorphic-git) | Só simulados com comandos git; em particular, não sei se respeitam `merge=union` nem se baixam a branch de índice |
| Latência de rede | Remoto sempre local; só estimativa |
| Windows e Linux | Tudo rodou em macOS |
| Vaults maiores que 2.000 notas; anexos binários em conflito | Fora do tamanho pedido; o código trata anexos como qualquer arquivo, sem teste |
| Grafo de extração cara (LLM) | Só o grafo de wikilinks foi implementado |
| Juntar um cérebro local com um remoto que já tem conteúdo | Recusado de propósito; históricos sem ancestral comum não são fundidos |
| Embedding real | Função falsa determinística; o custo real entra somando ao tempo medido |
