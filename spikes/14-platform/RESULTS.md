# Spike 14 — plataforma, empacotamento e escala

> Prova de conceito executada em 12/11/2026. Tudo o que está aqui foi **rodado**; o que não foi está listado na seção
> [O que ficou sem teste](#o-que-ficou-sem-teste). Os números de CI vêm de runners compartilhados do GitHub Actions
> (3–4 vCPUs) e variam ±30 % entre execuções — valem como ordem de grandeza e como comparação entre alternativas.

## Execuções do Actions (branch `spike/platform-matrix`)

| run | o que mudou | resultado |
|---|---|---|
| [43245445358](https://github.com/renanloureiroo/cabecao/actions/runs/43245445358) | primeira matriz (15 células + 12 versões de Node) | matriz verde; `tooling` vermelho (Biome reformatou YAML) |
| [43247317217](https://github.com/renanloureiroo/cabecao/actions/runs/43247317217) | bissecção de versão do Node, rajadas de watcher feitas por outro processo, `\\?\` no Windows | matriz verde; `tooling` vermelho só no Windows (CRLF) |
| [43249525753](https://github.com/renanloureiroo/cabecao/actions/runs/43249525753) | bootstrap com checagem de versão, job de escala, correções do ferramental | **62/62 jobs verdes** |
| [43251143996](https://github.com/renanloureiroo/cabecao/actions/runs/43251143996) | contagem de watches do inotify | **62/62 verdes — é a execução usada nas tabelas abaixo** |
| [43252931712](https://github.com/renanloureiroo/cabecao/actions/runs/43252931712) | só a célula extra Alpine/musl | ver [Alpine](#extra-alpine-linux-musl) |

Matriz principal: `ubuntu-latest` (x64), `ubuntu-24.04-arm`, `macos-latest` (arm64), `windows-latest` (x64) e
`windows-11-arm` × Node 22.23.4, 24.22.2 e 26.13.1 (os três LTS ativos; o "current" hoje é o 27 em alfa, testado como
`27-nightly`). Local: macOS (Darwin 27) / Apple M3 Pro, 12 núcleos / Node 24.21, **com a máquina sob carga pesada de outros trabalhos**
(load average 12–30 em 12 núcleos) — por isso a escala também foi repetida em runner limpo.

## Recomendações fechadas

| tema | decisão | prova |
|---|---|---|
| **Versão mínima do Node** | `engines: "^22.16.0 \|\| >=24.0.0"`; recomendar 24 LTS (≥ 24.15 não emite aviso experimental). Bootstrap de 10 linhas recusa versões antigas com mensagem clara. | tabela B: FTS5 só existe no `node:sqlite` a partir de **22.16.0**; 22.13–22.15 e toda a linha 23 abrem o módulo mas **não têm FTS5** |
| **Driver SQLite** | `node:sqlite` embutido, zero dependência. Plano B documentado: `better-sqlite3` 13. | 15/15 células + 2 Alpine: FTS5, WAL, dois processos escrevendo, acento/espaço, CRLF — tudo verde |
| **Vetores** | Força bruta em JS sobre `Int8Array` em memória; persistir em BLOBs de 1024 vetores no próprio SQLite. **Não usar `sqlite-vec`.** | `vec0` KNN 100k: 39–87 ms vs JS 31–70 ms (mesma ordem); `sqlite-vec` **não tem binário para Windows arm64 nem para musl** |
| **Parser de Markdown** | Parser próprio por varredura de linha + `yaml` para o frontmatter (com a ressalva de método da seção 5). | 34/34 casos vs 29–30/34; 21,7 mil notas/s vs 8,5 mil (`markdown-it`) e 1,7 mil (remark) |
| **Watcher** | `fs.watch` recursivo nativo **só como gatilho** (qualquer evento ou evento sem nome ⇒ varredura incremental por mtime+tamanho com debounce). Se um dia for preciso evento por arquivo: `chokidar`. Não usar `@parcel/watcher`. | varredura "nada mudou" de 30 mil notas: 0,3–0,8 s; `fs.watch` perde eventos em rajada no Windows; `@parcel/watcher` perde arquivos em pasta recém-criada no Linux; `chokidar` 18/18 em todas as células |
| **Empacotamento / `npx`** | Bundle sem dependências de runtime (tsdown), com *code splitting* e bootstrap separado. | tarball 158 KB; `npx` frio 0,7–1,2 s (Linux/macOS) e 6–11 s (Windows) contra 1,1–2,1 s e 13–22 s com dependências normais |
| **Runtime de embeddings** | Opcional, instalado sob demanda em `~/.cache/cabecao/runtime` (`%LOCALAPPDATA%\cabecao\runtime` no Windows) com `npm install` e carregado por URL de arquivo. `@huggingface/transformers` + `onnxruntime-node`. | instala e roda nas 15 células em 6–43 s (não carrega em Alpine/musl: recuo WASM provado); núcleo continua com cold start de ~60–210 ms |
| **Agendamento** | LaunchAgent (macOS), `systemd --user` timer (Linux), `schtasks` (Windows), todos por usuário e sem admin. | registrado, disparado, execução conferida e removido nas 15 células |
| **Build / release** | pnpm workspaces + tsdown + Vitest + Biome + TypeScript 7 (`tsc`) + Changesets + trusted publishing (OIDC). | job `tooling` verde em Linux/macOS/Windows e Node 22/24/26 |

---

## 1. Matriz de plataforma — `node:sqlite`

Resultado: **todas as 15 células passaram em todas as verificações**, com uma única ressalva (caminho longo no
Windows). Tabelas A e A2 no fim do documento.

- **Sem flag e com FTS5** nas três LTS atuais; `tokenize='unicode61 remove_diacritics 2'` casa `migracao operacao` com
  `migração … operação`, maiúsculas acentuadas e prefixo.
- **`loadExtension`** existe e funciona (`allowExtension: true`) em todas as células — é o que o `sqlite-vec` usa.
- **WAL** funciona em todas, inclusive Windows: leitor não bloqueia escritor, e **dois processos** fazendo 400
  transações de escrita cada (com `busy_timeout`) terminaram com 800 linhas, zero `SQLITE_BUSY` e `integrity_check ok`.
  No Windows isso é ~10× mais lento (1,6–2,9 s contra 0,12–0,2 s), mas correto.
- **Acento e espaço** (`Segundo Cérebro/Anotações & ideias (ção)/índice do cérebro.db`): abre em todas.
- **CRLF**: bytes preservados na ida e volta, o texto com `\r\n` é indexado e encontrado; o parser trata `\r?\n`.
- **Fechar e apagar** (`close()` libera `.db`, `-wal` e `-shm`): ok também no Windows.
- **Desempenho relativo**: inserir 50 mil trechos em FTS5 leva 0,2–0,26 s em Linux/macOS e 0,5–1,0 s no Windows; a
  consulta BM25 fica em 21–35 ms em todas; força bruta int8 100k×384d em 39–104 ms.

### Armadilhas reais encontradas

1. **Caminho longo no Windows.** `fs.*` do Node grava além de 260 caracteres, mas `new DatabaseSync(caminho)` falha
   com `unable to open database file` a partir de ~265 caracteres (testado com 265 e 433), mesmo com
   `LongPathsEnabled=1` no runner. **Contorno provado:** prefixar o caminho com `\\?\` — abre e grava em WAL. URL
   `file:` não resolve. Decisão: o índice fica no diretório de dados do usuário (caminho curto), não dentro do vault;
   se algum dia ficar no vault, usar o prefixo.
2. **Unicode em nomes de arquivo.** Todos os sistemas devolvem o nome em NFC como foi gravado. No macOS um caminho em
   NFD abre o arquivo NFC (o sistema normaliza); em Linux e Windows **não** (são arquivos diferentes e podem
   coexistir). O indexador normaliza caminho e alvo de link para NFC antes de comparar.
3. **Maiúsculas/minúsculas.** macOS e Windows são insensíveis; Linux é sensível. Resolver wikilinks pelo nome em
   minúsculas (como o Obsidian) evita divergência entre máquinas.
4. **Tamanho do nome de arquivo.** 258 caracteres ASCII: `ENAMETOOLONG` em Linux/macOS, `ENOENT` no Windows.
   Um nome de 200 cedilhas + `.md` (203 caracteres, 403 bytes em UTF-8) **passa em macOS e Windows e falha no
   Linux**, cujo limite é de 255 *bytes*: título acentuado longo que funciona numa máquina quebra o `git pull` na outra.

### Versão mínima do Node (tabela B)

Faixas delimitadas pelas versões realmente executadas (lista completa na tabela B):

| faixa | `node:sqlite` | FTS5 | aviso experimental |
|---|---|---|---|
| 20.x | não existe | — | — |
| 22.5.0, 22.12.0, 23.3.0 | só com `--experimental-sqlite` | — | — |
| 22.13 – 22.15 | sem flag | **não** | sim |
| **22.16 – 22.23** | sem flag | **sim** | sim (ainda em 22.23.4) |
| 23.4.0, 23.11.1 (última da linha) | sem flag | **não** | sim |
| 24.0 – 24.14 | sem flag | sim | sim |
| **24.15+** | sem flag | sim | **não** |
| 25.0 – 25.6 | sem flag | sim | sim |
| 25.7+, 26.x, 27-nightly | sem flag | sim | não |

`backup()` também só aparece em 22.16. O bundle do spike indexou e buscou em todas as versões ≥ 22.16 testadas
(22.16 a 22.23, 24.0 a 24.20, 25.0 a 25.9, 27-nightly) e, nas anteriores, o bootstrap recusa com
`cabecao precisa de Node.js 22.16+ ou 24+ …` em vez de estourar um stack trace. Sem o bootstrap separado, o erro em
Node 20 era um `ERR_UNKNOWN_BUILTIN_MODULE` cru, porque o `import` estático de `node:sqlite` é avaliado antes de
qualquer código do bundle. O mesmo bootstrap filtra o `ExperimentalWarning` do SQLite (stderr limpo em 22.16–24.14).

## 2. Alternativas: `better-sqlite3` e `sqlite-vec` (tabela C)

- **`better-sqlite3` 13.1.1**: carrega em todas as 15 células, no Node 27-nightly e no Alpine. Não compila nada: a
  versão 13 é N-API e traz os binários de 8 plataformas **dentro do pacote** (27 MB), sem script de instalação.
  Traz SQLite 3.54.1 com FTS5. Mesmo trabalho nos dois drivers: empate — 50 mil inserções em FTS5 em 120–282 ms
  (`node:sqlite`) contra 135–249 ms, BM25 em 20–42 ms contra 20–36 ms. Não há ganho que justifique 27 MB e uma
  dependência nativa; fica como plano B se o `node:sqlite` regredir.
- **`sqlite-vec` 0.1.9**: carrega com `node:sqlite` e com `better-sqlite3` em Linux x64/arm64, macOS arm64 e Windows
  x64. **Falha no Windows arm64** (`Unsupported platform`: não existe o pacote `sqlite-vec-win32-arm64`).
  KNN no `vec0` (int8[384], cosseno) sobre 100 mil vetores: 39–87 ms. A força bruta em JS com a mesma métrica: 31–70 ms,
  e devolve o mesmo top-1. Inserir 100 mil vetores no `vec0` custa 0,37–0,75 s.
- **Veredito:** `sqlite-vec` não se justifica nesta escala — não é mais rápido, não cobre todas as plataformas e
  obriga a habilitar carga de extensão.

## 3. Embeddings em cada plataforma (tabela D)

Modelo `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (q8, 384d, 129 MB em cache).

- **`@huggingface/transformers` 4.3.2 + `onnxruntime-node`** instala e roda nas 15 células:
  `npm install` em 5,5–9,3 s (Linux/macOS/Windows x64) e 27–42 s (Windows arm64); **462–473 MB** em disco, exceto
  **Linux x64: 723–733 MB** (o `onnxruntime-node` sozinho ocupa 548 MB ali, contra 287 MB nas outras).
- Carga do modelo em cache: 0,7–1,8 s. Vazão em trechos de ~350 tokens: 15–48/s (Linux, Windows), 8–9/s no macOS do
  runner (M1 virtual de 3 núcleos; local, no M3 Pro, 48/s). RSS do processo: 570–750 MB.
- **Primeira carga com download**: 3–11 s em Node 22/24, mas **20–38 s em Node 26** nas cinco plataformas e nas duas
  execuções em que medi. A causa não foi investigada (o download é feito pelo `fetch` do próprio Node).
- **Os vetores não são idênticos entre plataformas** para o modelo quantizado: cosseno mínimo contra o macOS arm64 de
  0,994 (x64), 0,995 (Windows arm64) e 0,998 (Linux arm64), e o top-1 do mini-teste muda (4/6 em x64, 5/6 em arm64). Consequência de
  arquitetura: o índice vetorial é **por máquina** e não deve ser sincronizado pelo git.
- **WASM como alternativa sem binário nativo:**
  - `device: 'wasm'` do transformers.js **não funciona em Node** (`Unsupported device: "wasm". Should be one of:
    coreml, webgpu, cpu`), nem importando o build web.
  - `onnxruntime-web` + `@huggingface/tokenizers` direto **funciona nas 15 células**: 151 MB instalados, dos quais só
    **14,5 MB são necessários** (um `.wasm`, dois `.mjs` e o tokenizador). É 3–10× mais lento que o nativo
    (2,3–9,5 trechos/s; com 4 threads 3,2–9,0), usa mais memória (700–1040 MB) e produz vetores levemente diferentes
    (cosseno mínimo de 0,990 contra o nativo da mesma máquina; top-1 do mini-teste 4/6).
  - Veredito: nativo como padrão; WASM só como degrau de emergência onde não houver binário (ver Alpine).
- **npm ≥ 11.19 bloqueia scripts de instalação por padrão** (`allowScripts`): os `postinstall` de `onnxruntime-node` e
  `protobufjs` não rodam em Node 24/26 e mesmo assim tudo funcionou — os binários de CPU já vêm no pacote.

## 4. Pacote e `npx` (tabelas E e E2)

Pacote de mentira `cabecao-spike` (nunca publicado; `npm pack` + `npx <tarball>`), com `index`, `search`, `mcp`
(servidor MCP em stdio com `@modelcontextprotocol/server`) e `embeddings`. Dependências: `yaml`, `zod`, SDK do MCP.

| | bundle (1 arquivo + bootstrap) | dependências normais |
|---|---|---|
| tarball | 158 KB | 9,5 KB |
| instalado | 0,5 MB, 4 arquivos | 14,6 MB, ~1240 arquivos |
| `npx` frio — Linux | 0,66–1,17 s | 1,1–1,4 s |
| `npx` frio — macOS | 1,0–1,1 s | 1,5–2,1 s |
| `npx` frio — Windows | **6,5–10,7 s** | **12,9–21,8 s** |
| `npx` quente | 0,46–0,96 s (Windows 0,84–1,8 s) | igual, ±10 % |
| `npm install <tarball>` no Windows | 0,4–1,1 s | 10–20 s |
| MCP: do `spawn` à 1ª resposta de `tools/call` | 98–183 ms (Windows arm64 197–232 ms) | 143–175 ms (Windows 159–386 ms) |
| processo novo fazendo `search` | 55–117 ms (Windows arm64 149–173 ms) | praticamente igual |
| `--version` | 47–93 ms (Windows arm64 136–157 ms) | **25–63 ms** (Windows arm64 102–116 ms) |

- O `npx` quente custa ~0,5 s **só de npm** antes de o programa rodar; o MCP configurado como `npx cabecao mcp` paga
  isso a cada início de sessão. Vale oferecer `npm i -g`/caminho direto para o `node` na configuração do cliente.
- O bundle único é mais lento no `--version` porque avalia os 560 KB (SDK do MCP e zod incluídos) em todo comando.
  **Com *code splitting* isso some** — medido localmente (macOS, Node 24.21): `--version` 59 ms no bundle único,
  **40 ms** no bundle dividido em 8 arquivos (546 KB no total), 40 ms com dependências normais, 36 ms o `node` vazio.
- No Windows, ~1240 arquivos pequenos custam 10–20 s de instalação. É o argumento mais forte a favor do bundle.

### Núcleo leve + runtime de embeddings sob demanda (E2)

`cabecao embeddings install` grava `package.json` + um `loader.mjs` de uma linha em `<dados>/runtime`, roda
`npm install @huggingface/transformers@<versão fixada>` e depois carrega com `import(pathToFileURL(loader))`.

- Funcionou nas 15 células, no diretório real do sistema: `~/.cache/cabecao` (Linux e macOS) e
  `%LOCALAPPDATA%\cabecao` (Windows). Instalação: 5,6–9,4 s (Linux/macOS), 28–43 s (Windows).
- Achar o npm: dentro do `npx`, `npm_execpath` aponta para o `npm-cli.js` e basta rodá-lo com o mesmo `node`; fora
  do `npx`, o `npm-cli.js` ao lado do executável do Node foi encontrado em todas. **Nenhuma das duas rotas usa
  `shell: true`**, o que evita a armadilha do `npm.cmd` no Windows.
- Sem o runtime, o comando falha com `cabecao: runtime de embeddings não instalado: rode cabecao embeddings install`.
- Depois de instalado: 1º uso com download do modelo 2,4–5 s (22–32 s em Node 26), uso em cache ~1–2,4 s por processo
  (≈0,1–0,2 s de import + 0,7–1,8 s de carga do modelo). O `search` do núcleo continua em 58–210 ms.
- Consequência: **não carregar o modelo por processo de CLI**; embutir consultas no servidor MCP, que fica vivo.

## 5. Escala

### Indexação (30 mil notas ≈ 87 MB de Markdown, 113 mil trechos, 174 mil links)

Vault sintético em português: frontmatter YAML (1 % malformado de propósito), wikilinks com alias/seção/embed,
seções, blocos de código com `[[`, um terço dos arquivos em CRLF, média de ~400 palavras.
Pipeline: varrer → `yaml` → parser próprio → chunks → `node:sqlite` (`notes`/`chunks`/`edges` + FTS5 com gatilhos).

| 30 mil notas | macOS local (M3 Pro, sob carga) | Linux x64 (runner) | macOS arm64 (runner M1) | Windows x64 (runner) |
|---|---|---|---|---|
| do zero | **17,2 s** | **12,6 s** | 26,6 s | 26,1 s |
| pico de memória (RSS) | 147 MB | 150 MB | 152 MB | 99 MB |
| "nada mudou", mtime+tamanho | **0,36 s** | 0,31 s | 0,47 s | 0,81 s |
| "nada mudou", hash de tudo | 1,33 s | 0,58 s | 3,56 s | 3,04 s |
| 10 notas alteradas, mtime+tamanho | **0,49 s** | 0,35 s | 1,05 s | 0,95 s |
| 10 notas alteradas, hash | 1,45 s | 0,68 s | 3,20 s | 3,13 s |
| 5 removidas + 5 renomeadas | 0,43 s | 0,40 s | 0,67 s | 0,94 s |
| banco | 184,5 MB (2,1× o vault) | igual | igual | igual |

Do zero com 1 mil notas: 0,6–1,0 s; com 10 mil: 4,3–8,2 s (crescimento linear). Banco: 6,1 MB e 61,8 MB. Todos os
tempos são de processo inteiro (incluem ~60–100 ms de partida do Node). Linhas de 1 mil e 10 mil na tabela H e em
`scale/results-index.json`. Uma segunda rodada local, com load average 30, levou 45 s para as 30 mil notas
(`scale/results-index.carga-alta.json`) — os números locais são pessimistas.

- 60–65 % do tempo "do zero" é escrita no SQLite (FTS5 + índices); o parse fica em 12–18 %.
- **Detecção por mtime+tamanho é 2–7× mais barata que hash de tudo** e basta no dia a dia. O indexador do spike já
  combina as duas: só lê e faz hash dos arquivos cujo mtime/tamanho mudou, e pula os de hash igual — é o que evita
  reindexar tudo depois de um `git checkout` (comportamento implementado; esse cenário específico não foi cronometrado).
- Trechos saíram com 181 tokens em média (limite de 350; as seções do vault sintético são curtas): 3,8 trechos/nota.

### Consultas no índice de 30 mil notas (processo quente, p50)

| consulta | Linux x64 | macOS (local) | Windows x64 |
|---|---|---|---|
| BM25, termo raro | 0,10 ms | 0,10 ms | 0,25 ms |
| BM25, 2 termos comuns (casam 60 mil trechos) | 63 ms | 75 ms | 145 ms |
| BM25, frase de 17 palavras em OR (casa 111 mil) | 280 ms | 352 ms | 521 ms |
| backlinks de uma nota | 0,01 ms | 0,01 ms | 0,02 ms |
| vizinhança de 2 saltos (CTE recursiva) | 0,04 ms | 0,04 ms | 0,10 ms |
| processo novo fazendo `search` | 116 ms | 148 ms | 240 ms |

O custo do BM25 é proporcional ao número de trechos que casam, e o vault sintético é o pior caso (vocabulário de
poucas centenas de palavras: "arquitetura" aparece em 54 % dos trechos). Mesmo assim a correção é simples e foi
medida no mesmo índice (`scale/results-query.json`): tirar *stopwords* derruba a frase longa de 335 ms para 123 ms, e
`AND` primeiro (com `OR` só como recuo quando vier vazio) derruba para **14 ms**.

### Parser de Markdown (`scale/results-parsers.json`, 5 mil notas, macOS local)

| parser | casos certos | notas/s | MB/s | import |
|---|---|---|---|---|
| **próprio** (varredura de linha + regex + `yaml`) | **34/34** | **21 688** | 63 | 0 ms |
| `markdown-it` + regex nos tokens de texto | 29/34 | 8 494 | 24,7 | 9 ms |
| `mdast-util-from-markdown` (o parser do remark) + regex nos nós de texto | 30/34 | 1 726 | 5,0 | 30 ms |
| `unified` + `remark-parse` + `remark-frontmatter` | 30/34 | 1 710 | 5,0 | 43 ms |

Os 34 casos cobrem os pedidos (`[[` em bloco de código, frontmatter malformado, `![[embed]]`, `[[nota|alias]]`,
`[[nota#seção]]`) e mais: cerca com til, cerca longa aninhada, código inline e indentado, BOM, CRLF, `---` no corpo,
pipe escapado em tabela, título setext, colchetes escapados, links Markdown relativos, comentários `%%` e `<!-- -->`,
matriz em LaTeX. Honestidade sobre o método:

- **Fui eu quem escreveu os casos e o parser.** Uma primeira versão do parser próprio falhava em 6 dos 8 casos
  adversários que escrevi depois (cerca dentro de item de lista e de citação, comentários, título com código); foi
  corrigida e hoje passa em todos. Um vault real vai achar mais casos.
- As bibliotecas de AST erram por um motivo estrutural: `[[...]]` não é sintaxe CommonMark, então elas partem o texto
  em nós (`[[a_b|c_d]]` vira ênfase, `\[\[x\]\]` perde o escape) e não conhecem `%%comentário%%`. Dá para corrigir
  com uma extensão de sintaxe própria, mas aí o custo de manutenção passa a ser o mesmo, com 3–12× menos velocidade.
- Limite conhecido do parser próprio: não é um parser CommonMark. Ele só precisa achar frontmatter, títulos, links e
  fronteiras de bloco — e é isso que os testes cobrem.

### Vetores em memória

Carregar do disco para um `Int8Array` (384d), macOS local e runners (tabela H2):

| | 100 mil (37 MB) | 300 mil (110 MB) |
|---|---|---|
| arquivo binário plano | 5–19 ms | 16–61 ms |
| SQLite, 1 BLOB por trecho | 121–239 ms | 325–678 ms |
| **SQLite, BLOBs de 1024 vetores** | **18–44 ms** | **48–122 ms** |
| RAM a mais no processo | 37–73 MB | 110–189 MB |
| busca top-10 depois de carregado | 31–67 ms | 97–185 ms |

### Até onde o desenho "SQLite + vetores em memória por processo" é confortável

- **Confortável até ~30 mil notas / ~100–120 mil trechos** (medido): índice do zero em 13–27 s, sincronização
  incremental em 0,35–1,05 s, 37–45 MB de vetores, busca vetorial em 30–105 ms, banco de ~185 MB, pico de 150 MB.
- **Aceitável até ~80 mil notas / 300 mil trechos** (vetores medidos; indexação extrapolada): 110 MB de vetores por
  processo e 100–350 ms por busca vetorial. O que incomoda primeiro é a reindexação total (linear: 40–90 s por
  100 mil notas, por extrapolação) e o BM25 de termos muito comuns — não a memória.
- **Além disso** (medidas a tomar na ordem, nenhuma testada aqui): pré-filtrar por BM25/metadados e só então pontuar
  vetores dos candidatos; quantização binária com re-ranking int8; particionar o índice por pasta/ano; e só então um
  índice aproximado (HNSW) — que é o único caso em que `sqlite-vec`/outro motor voltaria à mesa.
- Vários processos (CLI + servidor MCP + `sync` agendado) carregam cada um a sua cópia dos vetores; por isso a busca
  vetorial deve morar no processo de vida longa (o servidor MCP) e a CLI não deve carregá-los para `search` textual.

## 6. Watcher de arquivos (tabela F)

Vault de 10 mil arquivos, 18 cenários por watcher, em processo isolado: modificar, criar, apagar, renomear, mover para
pasta nova, salvamento atômico (temporário + `rename`), salvamento *in-place*, salvamento com backup (estilo vim),
caminho acentuado, renomear pasta, rajadas de 500/300/300 feitas por **outro processo**, "git pull" de 200
substituições, pasta nova chegando com 50 arquivos, e a mesma rajada feita dentro do processo do watcher.

| | Linux (x64/arm64) | macOS arm64 | Windows (x64/arm64) |
|---|---|---|---|
| `fs.watch(dir, { recursive: true })` | 18/18 | 18/18 | **13/18** |
| `chokidar` 6.0.0 | 18/18 | 18/18 | 18/18 |
| `@parcel/watcher` 2.6.0 | **16/18** | 18/18 | 18/18 |

- **`fs.watch` no Windows perde eventos em rajada**: de 500 modificações feitas por outro processo chegaram 231–458;
  de 300 criações, 53–86; de uma pasta nova com 50 arquivos, 9–29. Junto vieram 14–19 eventos **sem nome de arquivo**,
  que é o sinal de estouro de buffer. Eventos isolados, renomeação e os três estilos de salvamento chegam certos.
- **`@parcel/watcher` no Linux perde arquivos de pasta recém-criada**: 0 de 50 no cenário "git pull traz pasta nova" e
  o destino de "mover para pasta nova" — nas 6 células Linux, em todas as execuções em que o cenário existiu. É binário nativo, e o
  script de instalação dele é bloqueado pelo npm novo (funciona mesmo assim, via pacote pré-compilado).
- **`chokidar`** acertou tudo em todas as células, mas leva 0,2–1,4 s para ficar pronto com 10 mil arquivos (varre a
  árvore), usa 85–125 MB e a versão 6 exige Node ≥ 22.22 — acima do mínimo proposto.
- **`fs.watch` no Linux com Node 22 abre um watch do inotify por arquivo**: 10 019 watches para 10 mil arquivos
  (Node 24/26: 19, um por pasta, igual a `chokidar` e `@parcel/watcher`). O limite por usuário no runner era 129 mil;
  há distribuições com 8 192. Em Node 22 um vault grande pode estourar `max_user_watches`.
- Renomear arquivo aparece como par `rename`/`rename` (nativo) ou `unlink`+`add` (chokidar): **nenhum dos três informa
  "A virou B"**. Renomeação tem de ser reconstruída pelo indexador (mesmo hash, caminho novo).
- Salvamento atômico e *in-place*: os três watchers pegam nos três sistemas.

**Decisão:** o watcher não é a fonte da verdade. Usar `fs.watch` recursivo nativo como campainha (qualquer evento, ou
evento sem nome, agenda uma varredura incremental com debounce de ~0,5–1 s) e deixar a varredura por mtime+tamanho —
que custa 0,3–0,8 s para 30 mil notas — decidir o que mudou. Isso tolera perda de eventos, não adiciona dependência e
é o mesmo código do `cabecao sync` agendado. Em Linux com Node 22, tratar `ENOSPC` caindo para varredura periódica.

## 7. Agendamento sem daemon (tabela G)

Geradores em `matrix/07-schedule/gen.mjs`, exemplos em `matrix/07-schedule/examples/`. No CI cada célula **registrou
a tarefa, disparou, conferiu que o comando rodou (arquivo marcador) e removeu**; localmente só validei a sintaxe
(`plutil -lint`), sem carregar nada.

| SO | mecanismo | instalar | validado |
|---|---|---|---|
| macOS | LaunchAgent em `~/Library/LaunchAgents/dev.cabecao.sync.plist`, `StartInterval` 1800 | `launchctl bootstrap gui/$(id -u) <plist>` | `plutil -lint` (local e CI); `bootstrap` em `gui/501`, `kickstart` executou, `print` mostra `run interval = 1800`, `bootout` — nos 3 Nodes |
| Linux | `~/.config/systemd/user/cabecao-sync.{service,timer}` (`OnUnitActiveSec`, `Persistent=true`) | `systemctl --user daemon-reload && systemctl --user enable --now cabecao-sync.timer` | `systemd-analyze verify --user` (systemd 255 e 259), `enable --now`, `start` executou, `disable` — x64 e arm64 |
| Windows | Agendador de Tarefas, tarefa do usuário atual | `schtasks /Create /F /TN "Cabecao Sync" /SC MINUTE /MO 30 /TR "\"node.exe\" \"cabecao.mjs\" sync"` | `/Create`, `/Query` (`Interactive only`, repete a cada 30 min), `/Run` executou, `/Delete` — x64 e arm64, sem elevação |

Ressalvas medidas:

- **`schtasks /TR` aceita no máximo 261 caracteres**: um comando de 464 foi recusado
  (`Value for '/TR' option cannot be more than 261 character(s)`). O comando agendado tem de ser curto — o caminho do
  vault vem de um arquivo de configuração, não da linha de comando.
- Sem `/RU`, a tarefa do Windows é `Interactive only`: roda só com o usuário logado (é o que se quer; dispensa senha).
- No runner Linux `Linger=yes` e o `systemd --user` estava `running`. Em desktops sem *linger* o timer só roda com
  sessão aberta; `loginctl enable-linger` resolve mas pode pedir autenticação. `crontab` existe no runner como recuo.

## 8. Ferramental de build e release

Exemplo mínimo em `tooling/` (monorepo pnpm com `packages/core` e `packages/cli`), exercitado pelo job `tooling` em
Linux, macOS e Windows com Node 24, e em Linux com Node 22 e 26 — todos verdes nos runs 43249525753 e 43251143996
(os tempos da tabela são do primeiro).

| papel | escolha | medido no CI (Linux, Node 24) |
|---|---|---|
| gerenciador | pnpm 10 (`packageManager` + `pnpm/action-setup@v6`) | `pnpm install --frozen-lockfile` 2,5 s (Windows 5,0 s, macOS 6,2 s) |
| bundler | **tsdown 0.23** (Rolldown) — `deps.alwaysBundle` embute workspace + npm | 1,1 s; `dist/cli.mjs` de 114 KB com `yaml` dentro, zero dependências |
| testes | **Vitest 5** | 1,1 s (3 testes, usando `node:sqlite` de verdade) |
| lint + formatação | **Biome 2.6** (uma ferramenta, um binário) | 0,4 s |
| tipos | TypeScript 7.0.2 (`tsc --noEmit`) | 0,5 s |
| checagem do pacote | `publint` | "All good!" |
| versão + changelog | **Changesets 3** | `changeset version` gerou `CHANGELOG.md` com `## 0.1.0` |
| publicação | `changesets/action@v2` + **trusted publishing** (OIDC), sem `NPM_TOKEN` | `npm publish --dry-run` (com e sem `--provenance`) e `pnpm publish --dry-run` ok |

- `node src/cli.ts` rodou direto em Node 22.23, 24.22 e 26.13 (remoção de tipos nativa): dá para desenvolver sem
  etapa de build, com `erasableSyntaxOnly` no `tsconfig`.
- **O que o `--dry-run` prova e o que não prova.** Prova que o pacote monta (2 arquivos, 35 kB), que as flags são
  aceitas e que o job tem `id-token: write`. **Não gera a atestação** nem fala com o registro. Para chegar mais perto,
  o job pede um token OIDC com a audiência `npm:registry.npmjs.org` e imprime só as *claims* — é exatamente o que o
  npm confere no cadastro do *trusted publisher*: `repository: renanloureiroo/cabecao`, `repository_visibility: public`,
  `workflow_ref: …/.github/workflows/<arquivo>.yml@refs/heads/<branch>`, `runner_environment: github-hosted`.
  Requisitos da documentação do npm: CLI ≥ 11.5.1 e Node ≥ 22.14 no job de release (usar Node 24).
- **Changesets × release-please.** Só o Changesets foi executado. Escolho Changesets porque o projeto é monorepo e a
  intenção de versão fica num arquivo revisável no PR, sem depender de todo commit seguir Conventional Commits; o
  `release-please` (17.x, `release-please-action@v5`) continua sendo a opção se a preferência for derivar tudo dos
  commits — essa comparação é de leitura, não de execução.
- `tooling/release.example.yml` é o workflow de release proposto (não ativo). Para ligar é preciso, do lado do dono do
  repositório: cadastrar o *trusted publisher* em npmjs.com e permitir que o Actions crie pull requests.

### Armadilhas que o CI pegou no ferramental

1. **Biome formata YAML e Markdown**: reprovou o workflow de exemplo e **reescreveu o arquivo de changeset**
   (`---\n"pkg": minor\n---` virou título setext), o que quebra `changeset version`. Excluir `.changeset/*.md`.
2. **CRLF no Windows**: sem `.gitattributes` com `* text=auto eol=lf`, o `biome check` falha no checkout do Windows.
3. **`"bin": "./dist/cli.mjs"`**: o npm 11 avisa `script name … was invalid and removed`. Sem o `./` não há aviso.
4. **"Sou o módulo principal?"** (`import.meta.url` × `process.argv[1]`) falha quando o bin roda pelo symlink de
   `node_modules/.bin`: o comando instalado não imprimia nada. O arquivo do bin deve só chamar `main()`.
5. `changeset status` precisa do histórico de `main` (`fetch-depth: 0`); com checkout raso falha, `version` não.
6. Versões das actions usadas (as mais recentes hoje): `checkout@v7`, `setup-node@v7`, `upload-artifact@v7`,
   `pnpm/action-setup@v6`; o exemplo de release usa `changesets/action@v2`, cujas entradas mudaram de nome
   (`version-script`, `publish-script`) e que não lê mais `NPM_TOKEN`.

## Outras armadilhas de distribuição

- **npm 11.19+ não roda scripts de instalação de dependências por padrão** (`npm warn install-scripts …`). Todos os
  pacotes testados funcionaram sem eles (`esbuild`, `onnxruntime-node`, `protobufjs`, `@parcel/watcher`), mas
  qualquer dependência futura que dependa de `postinstall` vai falhar em silêncio. Mais um motivo para zero deps.
- **Download de artefatos do Actions** devolveu `503 Egress is over the account limit` várias vezes; repetir resolve.

## Extra: Alpine Linux (musl)

Célula extra em contêiner `node:22-alpine` e `node:24-alpine` (x64), run
[43252931712](https://github.com/renanloureiroo/cabecao/actions/runs/43252931712); JSON em `results/ci/alpine-node*/`.

| verificação | resultado no Alpine |
|---|---|
| `node:sqlite` (14 verificações: FTS5, WAL, 2 processos, acento, CRLF…) | **tudo ok** — SQLite 3.54.1; FTS5 insert 50k em 315–324 ms, BM25 25 ms |
| bundle: `npx` frio / quente, `search`, MCP | ok — 1,05 s / 0,65–0,68 s, 74–78 ms, 140–143 ms |
| `better-sqlite3` | carrega (traz binário musl) |
| `sqlite-vec` | **falha**: o pacote `sqlite-vec-linux-x64` é glibc (`Error loading shared library … vec0.so`) |
| `@huggingface/transformers` + `onnxruntime-node` | instala (723–733 MB em 9 s) mas **não carrega**: `Error loading shared library ld-linux-x86-64.so.2` |
| runtime opcional sob demanda | instala, e o primeiro uso falha com o mesmo erro (mensagem limpa, sem stack trace) |
| `onnxruntime-web` + `@huggingface/tokenizers` (WASM) | **funciona**: carga 1,5 s, 6,7–6,9 trechos/s, top-1 4/6 |
| watchers | `fs.watch` 18/18, `chokidar` 18/18, `@parcel/watcher` 16/18 (mesma falha do Linux glibc) |

Conclusão: o núcleo (SQLite + busca textual + MCP) roda em musl sem nenhum ajuste; embeddings nativos não. É o caso
concreto que justifica manter o caminho WASM como degrau de recuo — e o instalador do runtime deve **testar a carga
depois de instalar** e cair para WASM (ou avisar) em vez de deixar 720 MB inúteis no disco.

## O que ficou sem teste

- **macOS Intel e Windows 10**: os runners usados são macOS arm64 e Windows Server 2025 / Windows 11 arm.
- **Obsidian de verdade**: não abri o aplicativo. Testei os padrões de gravação possíveis (in-place, temporário +
  `rename`, backup + `rename`) e todos são detectados; qual deles o Obsidian usa em cada sistema não foi observado.
- **Publicação real e trusted publishing ponta a ponta**: nada foi publicado; só `--dry-run` e a emissão do token
  OIDC. A atestação de proveniência nunca foi gerada.
- **Registro local (verdaccio)**: usei `npm pack` + `npx <tarball>`. A variante com dependências baixou as
  dependências do registro público, então o custo de rede é real; a resolução de `npx cabecao` por nome não foi medida.
- **`release-please`**: não executado.
- **Agendamento no mundo real**: não medi a janela de console que o `node.exe` pode piscar no Windows a cada disparo,
  nem as permissões de privacidade do macOS (um LaunchAgent lendo `~/Documents` pode pedir autorização), nem
  Linux sem `systemd --user` (WSL antigo, contêineres). No macOS local o agente **não** foi carregado, por instrução.
- **Vault real**: só dados sintéticos; o vault pessoal não foi lido. A distribuição de vocabulário de um vault real
  é mais favorável ao BM25 e mais hostil ao parser do que a sintética.
- **Além de 30 mil notas** na indexação e além de 300 mil vetores; nenhuma das medidas do "plano além disso".
- **`fs.watch` recursivo em Node 22.16–22.22** (só 22.23.4 foi exercitado nos watchers).
- **Causa do download lento do modelo em Node 26** e ganho de `executionProviders` além de CPU (CoreML, WebGPU, CUDA).
- **Escala local limpa**: a máquina local estava ocupada; os números locais de escala são pessimistas.

## Como reproduzir

```sh
node matrix/01-sqlite.mjs            # node:sqlite
node matrix/02-vector.mjs            # força bruta
node matrix/03-alt-drivers/run.mjs   # better-sqlite3 + sqlite-vec (faz npm install)
node matrix/04-embeddings/run.mjs    # transformers + onnxruntime-node e WASM (baixa o modelo)
node matrix/05-package/run.mjs       # build, npm pack, npx frio/quente, MCP, runtime opcional
node matrix/06-watcher/run.mjs       # fs.watch × chokidar × @parcel/watcher
node matrix/07-schedule/run.mjs      # agendamento (fora do CI só valida sintaxe)
node scale/bench-index.mjs <pasta> 1000,10000,30000
node scale/bench-parsers.mjs <vault> 5000
node scale/bench-vectors.mjs <pasta>
node scale/bench-query.mjs <index.db>
node report/aggregate.mjs <artefatos baixados> <id do run>   # gera report/matrix.md
```

Resultados brutos: `results/ci/<célula>/*.json` (run 43251143996), `results/local/*.json` (macOS local) e
`scale/results-*.json`.

O workflow que roda tudo isso está em `.github/workflows/spike-platform.yml` na branch `spike/platform-matrix`
(cópia de leitura em `ci/spike-platform.yml` na pasta do spike do clone principal). Uma mensagem de commit com
`[so-alpine]` roda só a célula Alpine.

---

# Tabelas completas (geradas de `results/ci`)

<!-- gerado por report/aggregate.mjs a partir do run 43251143996 -->

### A. `node:sqlite` por plataforma × Node

| célula | Node | SQLite | sem flag | FTS5 | aviso experimental | loadExtension | WAL | 2 processos (busy) | acento/espaço | CRLF | caminho ~285 / ~425 | Windows: com prefixo `\\?\` | fecha e apaga |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Linux x64 · 22 | v22.23.4 | 3.53.4 | sim | sim | sim | sim | sim | ok (400+400, busy 0, 198.7 ms) | sim | sim | ok / ok | n/a | sim |
| Linux x64 · 24 | v24.22.2 | 3.53.4 | sim | sim | não | sim | sim | ok (400+400, busy 0, 170.5 ms) | sim | sim | ok / ok | n/a | sim |
| Linux x64 · 26 | v26.13.1 | 3.54.1 | sim | sim | não | sim | sim | ok (400+400, busy 0, 147.4 ms) | sim | sim | ok / ok | n/a | sim |
| Linux arm64 · 22 | v22.23.4 | 3.53.4 | sim | sim | sim | sim | sim | ok (400+400, busy 0, 205.2 ms) | sim | sim | ok / ok | n/a | sim |
| Linux arm64 · 24 | v24.22.2 | 3.53.4 | sim | sim | não | sim | sim | ok (400+400, busy 0, 193.2 ms) | sim | sim | ok / ok | n/a | sim |
| Linux arm64 · 26 | v26.13.1 | 3.54.1 | sim | sim | não | sim | sim | ok (400+400, busy 0, 173.3 ms) | sim | sim | ok / ok | n/a | sim |
| macOS arm64 · 22 | v22.23.4 | 3.53.4 | sim | sim | sim | sim | sim | ok (400+400, busy 0, 117.6 ms) | sim | sim | ok / ok | n/a | sim |
| macOS arm64 · 24 | v24.22.2 | 3.53.4 | sim | sim | não | sim | sim | ok (400+400, busy 0, 137.1 ms) | sim | sim | ok / ok | n/a | sim |
| macOS arm64 · 26 | v26.13.1 | 3.54.1 | sim | sim | não | sim | sim | ok (400+400, busy 0, 154.3 ms) | sim | sim | ok / ok | n/a | sim |
| Windows x64 · 22 | v22.23.4 | 3.53.4 | sim | sim | sim | sim | sim | ok (400+400, busy 0, 2891 ms) | sim | sim | fs:sim sqlite:**NÃO** / fs:sim sqlite:**NÃO** | sim | sim |
| Windows x64 · 24 | v24.22.2 | 3.53.4 | sim | sim | não | sim | sim | ok (400+400, busy 0, 1835 ms) | sim | sim | fs:sim sqlite:**NÃO** / fs:sim sqlite:**NÃO** | sim | sim |
| Windows x64 · 26 | v26.13.1 | 3.54.1 | sim | sim | não | sim | sim | ok (400+400, busy 0, 1627.5 ms) | sim | sim | fs:sim sqlite:**NÃO** / fs:sim sqlite:**NÃO** | sim | sim |
| Windows arm64 · 22 | v22.23.4 | 3.53.4 | sim | sim | sim | sim | sim | ok (400+400, busy 0, 1718.4 ms) | sim | sim | fs:sim sqlite:**NÃO** / fs:sim sqlite:**NÃO** | sim | sim |
| Windows arm64 · 24 | v24.22.2 | 3.53.4 | sim | sim | não | sim | sim | ok (400+400, busy 0, 1959.6 ms) | sim | sim | fs:sim sqlite:**NÃO** / fs:sim sqlite:**NÃO** | sim | sim |
| Windows arm64 · 26 | v26.13.1 | 3.54.1 | sim | sim | não | sim | sim | ok (400+400, busy 0, 2713.2 ms) | sim | sim | fs:sim sqlite:**NÃO** / fs:sim sqlite:**NÃO** | sim | sim |

### A2. Sistema de arquivos e desempenho relativo

| célula | CPU (núcleos) | FS preserva NFC | NFD abre NFC | case-insensitive | nome 258 chars | FTS5 insert 50k (ms) | BM25 50k (ms) | int8 100k×384 (ms) | int8 300k (ms) | float32 100k (ms) |
|---|---|---|---|---|---|---|---|---|---|---|
| Linux x64 · 22 | Intel Xeon Platinum 8370C (4) | sim | **NÃO** | **NÃO** | ENAMETOOLONG | 207.9 | 29.4 | 74 | 221.3 | 90.3 |
| Linux x64 · 24 | AMD EPYC 9V74 80-Core (4) | sim | **NÃO** | **NÃO** | ENAMETOOLONG | 256.7 | 24.4 | 63.9 | 192.4 | 64.2 |
| Linux x64 · 26 | AMD EPYC 9V74 80-Core (4) | sim | **NÃO** | **NÃO** | ENAMETOOLONG | 262.1 | 24.2 | 64 | 191.5 | 75 |
| Linux arm64 · 22 | unknown (4) | sim | **NÃO** | **NÃO** | ENAMETOOLONG | 240.5 | 27.4 | 69 | 208.3 | 85.6 |
| Linux arm64 · 24 | unknown (4) | sim | **NÃO** | **NÃO** | ENAMETOOLONG | 193.6 | 27.1 | 67.2 | 201.7 | 83 |
| Linux arm64 · 26 | unknown (4) | sim | **NÃO** | **NÃO** | ENAMETOOLONG | 206.3 | 27.3 | 66.7 | 200.1 | 87.4 |
| macOS arm64 · 22 | Apple M1 (Virtual) (3) | sim | sim | sim | ENAMETOOLONG | 256.3 | 27.7 | 104.2 | 351.9 | 119.3 |
| macOS arm64 · 24 | Apple M1 (Virtual) (3) | sim | sim | sim | ENAMETOOLONG | 195.2 | 26.6 | 87.7 | 282.7 | 101.2 |
| macOS arm64 · 26 | Apple M1 (Virtual) (3) | sim | sim | sim | ENAMETOOLONG | 230.3 | 22.9 | 70.6 | 274.7 | 112.4 |
| Windows x64 · 22 | AMD EPYC 9V74 80-Core (4) | sim | **NÃO** | sim | ENOENT | 977.1 | 35.2 | 83.2 | 248.8 | 83.2 |
| Windows x64 · 24 | AMD EPYC 9V45 96-Core (4) | sim | **NÃO** | sim | ENOENT | 523.7 | 21.4 | 38.6 | 115.3 | 46.5 |
| Windows x64 · 26 | AMD EPYC 7763 64-Core (4) | sim | **NÃO** | sim | ENOENT | 537.9 | 35.1 | 73.7 | 223.4 | 85.9 |
| Windows arm64 · 22 | Cobalt 100 (4) | sim | **NÃO** | sim | ENOENT | 630.6 | 30.4 | 68.9 | 207 | 85.9 |
| Windows arm64 · 24 | Cobalt 100 (4) | sim | **NÃO** | sim | ENOENT | 513.5 | 29.5 | 67.9 | 203.4 | 80 |
| Windows arm64 · 26 | Cobalt 100 (4) | sim | **NÃO** | sim | ENOENT | 566.8 | 29.1 | 65.5 | 195.9 | 83.7 |

### B. Versão mínima: `node:sqlite` por versão de Node (Linux x64)

| Node | npm | `node:sqlite` sem flag | com `--experimental-sqlite` | SQLite | FTS5 | aviso experimental | loadExtension | backup() | iterate() | bundle do spike indexa+busca |
|---|---|---|---|---|---|---|---|---|---|---|
| v20.20.2 | 10.8.2 | **NÃO** | não existe | — | — | — | — | — | — | recusa com mensagem clara |
| v22.5.0 | 10.8.2 | **NÃO** | sim (3.46.0) | — | — | — | — | — | — | recusa com mensagem clara |
| v22.12.0 | 10.9.0 | **NÃO** | sim (3.47.0) | — | — | — | — | — | — | recusa com mensagem clara |
| v22.13.0 | 10.9.2 | sim | — | 3.47.2 | **NÃO** | sim | sim | undefined | function | recusa com mensagem clara |
| v22.14.0 | 10.9.2 | sim | — | 3.47.2 | **NÃO** | sim | sim | undefined | function | recusa com mensagem clara |
| v22.15.0 | 10.9.2 | sim | — | 3.49.1 | **NÃO** | sim | sim | undefined | function | recusa com mensagem clara |
| v22.16.0 | 10.9.2 | sim | — | 3.49.1 | sim | sim | sim | function | function | ok (5 hits, stderr limpo) |
| v22.17.0 | 10.9.2 | sim | — | 3.50.0 | sim | sim | sim | function | function | ok (5 hits, stderr limpo) |
| v22.18.0 | 10.9.3 | sim | — | 3.50.2 | sim | sim | sim | function | function | ok (5 hits, stderr limpo) |
| v22.19.0 | 10.9.3 | sim | — | 3.50.4 | sim | sim | sim | function | function | ok (5 hits, stderr limpo) |
| v22.20.0 | 10.9.3 | sim | — | 3.50.4 | sim | sim | sim | function | function | ok (5 hits, stderr limpo) |
| v22.21.0 | 10.9.4 | sim | — | 3.50.4 | sim | sim | sim | function | function | ok (5 hits, stderr limpo) |
| v22.22.0 | 10.9.4 | sim | — | 3.50.4 | sim | sim | sim | function | function | ok (5 hits, stderr limpo) |
| v22.23.0 | 10.9.8 | sim | — | 3.51.3 | sim | sim | sim | function | function | ok (5 hits, stderr limpo) |
| v23.3.0 | 10.9.0 | **NÃO** | sim (3.47.0) | — | — | — | — | — | — | recusa com mensagem clara |
| v23.4.0 | 10.9.2 | sim | — | 3.47.1 | **NÃO** | sim | sim | undefined | function | recusa com mensagem clara |
| v23.11.1 | 10.9.2 | sim | — | 3.49.1 | **NÃO** | sim | sim | function | function | recusa com mensagem clara |
| v24.0.0 | 11.3.0 | sim | — | 3.49.1 | sim | sim | sim | function | function | ok (5 hits, stderr limpo) |
| v24.2.0 | 11.3.0 | sim | — | 3.50.0 | sim | sim | sim | function | function | ok (5 hits, stderr limpo) |
| v24.4.0 | 11.4.2 | sim | — | 3.50.2 | sim | sim | sim | function | function | ok (5 hits, stderr limpo) |
| v24.6.0 | 11.5.1 | sim | — | 3.50.4 | sim | sim | sim | function | function | ok (5 hits, stderr limpo) |
| v24.8.0 | 11.6.0 | sim | — | 3.50.4 | sim | sim | sim | function | function | ok (5 hits, stderr limpo) |
| v24.10.0 | 11.6.1 | sim | — | 3.50.4 | sim | sim | sim | function | function | ok (5 hits, stderr limpo) |
| v24.11.0 | 11.6.1 | sim | — | 3.50.4 | sim | sim | sim | function | function | ok (5 hits, stderr limpo) |
| v24.12.0 | 11.6.2 | sim | — | 3.50.4 | sim | sim | sim | function | function | ok (5 hits, stderr limpo) |
| v24.13.0 | 11.6.2 | sim | — | 3.50.4 | sim | sim | sim | function | function | ok (5 hits, stderr limpo) |
| v24.14.0 | 11.9.0 | sim | — | 3.51.2 | sim | sim | sim | function | function | ok (5 hits, stderr limpo) |
| v24.15.0 | 11.12.1 | sim | — | 3.51.3 | sim | não | sim | function | function | ok (5 hits, stderr limpo) |
| v24.16.0 | 11.13.0 | sim | — | 3.53.0 | sim | não | sim | function | function | ok (5 hits, stderr limpo) |
| v24.18.0 | 11.16.0 | sim | — | 3.53.1 | sim | não | sim | function | function | ok (5 hits, stderr limpo) |
| v24.20.0 | 11.19.0 | sim | — | 3.53.4 | sim | não | sim | function | function | ok (5 hits, stderr limpo) |
| v25.0.0 | 11.6.2 | sim | — | 3.50.4 | sim | sim | sim | function | function | ok (5 hits, stderr limpo) |
| v25.2.0 | 11.6.2 | sim | — | 3.50.4 | sim | sim | sim | function | function | ok (5 hits, stderr limpo) |
| v25.4.0 | 11.7.0 | sim | — | 3.51.1 | sim | sim | sim | function | function | ok (5 hits, stderr limpo) |
| v25.6.0 | 11.8.0 | sim | — | 3.51.2 | sim | sim | sim | function | function | ok (5 hits, stderr limpo) |
| v25.7.0 | 11.10.1 | sim | — | 3.51.2 | sim | não | sim | function | function | ok (5 hits, stderr limpo) |
| v25.8.0 | 11.11.0 | sim | — | 3.51.2 | sim | não | sim | function | function | ok (5 hits, stderr limpo) |
| v25.9.0 | 11.12.1 | sim | — | 3.51.3 | sim | não | sim | function | function | ok (5 hits, stderr limpo) |
| v27.0.0-nightly20261029510d84c330 | 12.1.0 | sim | — | 3.54.1 | sim | não | sim | function | function | ok (5 hits, stderr limpo) |

### C. Alternativas: `better-sqlite3` e `sqlite-vec`

| célula | npm | `npm i` (ms / MB) | scripts bloqueados | compilou (gyp)? | better-sqlite3 carrega (SQLite) | sqlite-vec em node:sqlite | sqlite-vec em better-sqlite3 | vec0 KNN 100k (ms) | JS cos 100k (ms) | vec0 insert 100k (ms) | FTS 50k insert node:sqlite / better (ms) | BM25 node:sqlite / better (ms) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Linux x64 · 22 | 10.9.9 | 1253 / 26.8 | nenhum | não | sim (3.54.1) | sim (v0.1.9) | sim | 61 | 58 | 538.1 | 177 / 202 | 29 / 27.6 |
| Linux x64 · 24 | 11.19.1 | 1069 / 26.8 | nenhum | não | sim (3.54.1) | sim (v0.1.9) | sim | 67.1 | 53.3 | 434.6 | 131.7 / 147.3 | 24.4 / 22.2 |
| Linux x64 · 26 | 11.20.0 | 855 / 26.8 | nenhum | não | sim (3.54.1) | sim (v0.1.9) | sim | 67.3 | 42.4 | 418.5 | 125.6 / 149.5 | 24.4 / 22.2 |
| Linux arm64 · 22 | 10.9.9 | 6806 / 26.8 | nenhum | não | sim (3.54.1) | sim (v0.1.9) | sim | 46.1 | 48.3 | 461.6 | 146.1 / 166.7 | 26.6 / 25.5 |
| Linux arm64 · 24 | 11.19.1 | 2321 / 26.8 | nenhum | não | sim (3.54.1) | sim (v0.1.9) | sim | 46 | 48.2 | 421.2 | 127.7 / 155.6 | 27.2 / 25.7 |
| Linux arm64 · 26 | 11.20.0 | 926 / 26.8 | nenhum | não | sim (3.54.1) | sim (v0.1.9) | sim | 46.2 | 42.5 | 439.9 | 134.7 / 157.2 | 27.3 / 25.5 |
| macOS arm64 · 22 | 10.9.9 | 1948 / 26.8 | nenhum | não | sim (3.54.1) | sim (v0.1.9) | sim | 51.6 | 52.1 | 567.8 | 214.8 / 210.7 | 41.9 / 35.8 |
| macOS arm64 · 24 | 11.19.1 | 2051 / 26.8 | nenhum | não | sim (3.54.1) | sim (v0.1.9) | sim | 52.3 | 67.4 | 744.6 | 282.2 / 227.8 | 31.4 / 29.1 |
| macOS arm64 · 26 | 11.20.0 | 1579 / 26.8 | nenhum | não | sim (3.54.1) | sim (v0.1.9) | sim | 51.4 | 46.1 | 586.5 | 177.3 / 194.5 | 39.2 / 21.9 |
| Windows x64 · 22 | 10.9.9 | 8812 / 27 | nenhum | não | sim (3.54.1) | sim (v0.1.9) | sim | 87.1 | 69.6 | 751.2 | 227.5 / 249.4 | 34.3 / 31.3 |
| Windows x64 · 24 | 11.19.1 | 4988 / 27 | nenhum | não | sim (3.54.1) | sim (v0.1.9) | sim | 38.9 | 31.2 | 366.3 | 119.9 / 135.1 | 19.9 / 19.6 |
| Windows x64 · 26 | 11.20.0 | 2659 / 27 | nenhum | não | sim (3.54.1) | sim (v0.1.9) | sim | 73.2 | 49.5 | 675.8 | 186.8 / 216.5 | 34.4 / 31.3 |
| Windows arm64 · 22 | 10.9.9 | 5717 / 26.7 | nenhum | não | sim (3.54.1) | **NÃO**: Unsupported platform for sqlite-vec, on a win32- | **NÃO**: Unsupported platform for sqlite-vec, on a win32- | — | — | — | 172.8 / 188.4 | 30.1 / 25.2 |
| Windows arm64 · 24 | 11.19.1 | 6260 / 26.7 | nenhum | não | sim (3.54.1) | **NÃO**: Unsupported platform for sqlite-vec, on a win32- | **NÃO**: Unsupported platform for sqlite-vec, on a win32- | — | — | — | 155 / 190.4 | 28.7 / 25.3 |
| Windows arm64 · 26 | 11.20.0 | 3825 / 26.7 | nenhum | não | sim (3.54.1) | **NÃO**: Unsupported platform for sqlite-vec, on a win32- | **NÃO**: Unsupported platform for sqlite-vec, on a win32- | — | — | — | 145.7 / 168.2 | 28.5 / 25.3 |

### D. Embeddings (`Xenova/paraphrase-multilingual-MiniLM-L12-v2`, q8)

| célula | `npm i transformers` (s / MB) | scripts bloqueados | nativo: 1ª carga c/ download (s) | nativo: carga em cache (ms) | nativo: trechos/s | nativo RSS (MB) | top-1 | cos mín. vs macOS arm64 | transformers `device: wasm` | `npm i` ort-web (s / MB; mínimo MB) | WASM: carga (ms) | WASM: trechos/s | WASM 4 threads: trechos/s | WASM RSS (MB) | cos mín. WASM vs nativo |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Linux x64 · 22 | 9.1 / 732.5 | nenhum | 4.2 | 1097 | 14.8 | 634 | 4/6 | 0.9941 | não suportado | 1.9 / 150.7; 14.5 | 1878 | 5.4 | 4.8 | 1001 | 0.9904 |
| Linux x64 · 24 | 9.3 / 723.1 | onnxruntime-node, protobufjs | 3.3 | 761 | 30.2 | 676 | 4/6 | 0.9941 | não suportado | 1.7 / 150.7; 14.5 | 1221 | 6.9 | 7 | 1030 | 0.9904 |
| Linux x64 · 26 | 9.0 / 723.1 | onnxruntime-node, protobufjs | 32.7 | 812 | 23.5 | 618 | 4/6 | 0.9941 | não suportado | 1.5 / 150.7; 14.5 | 1375 | 6.9 | 7 | 954 | 0.9904 |
| Linux arm64 · 22 | 5.5 / 471.8 | nenhum | 3.6 | 1023 | 29.9 | 631 | 5/6 | 0.9978 | não suportado | 1.8 / 150.7; 14.5 | 1696 | 2.9 | 4.6 | 984 | 0.9909 |
| Linux arm64 · 24 | 5.6 / 462.4 | onnxruntime-node, protobufjs | 3.4 | 860 | 31 | 677 | 5/6 | 0.9978 | não suportado | 1.8 / 150.7; 14.5 | 1367 | 2.9 | 5 | 1039 | 0.9909 |
| Linux arm64 · 26 | 5.6 / 462.4 | onnxruntime-node, protobufjs | 33.0 | 890 | 30 | 608 | 5/6 | 0.9978 | não suportado | 1.7 / 150.7; 14.5 | 1257 | 2.9 | 5.2 | 944 | 0.9909 |
| macOS arm64 · 22 | 8.1 / 471.5 | nenhum | 6.1 | 918 | 8.7 | 669 | 5/6 | 1.0000 | não suportado | 2.7 / 150.7; 14.5 | 3071 | 2.3 | 3.2 | 944 | 0.9905 |
| macOS arm64 · 24 | 9.3 / 462.1 | onnxruntime-node, protobufjs | 11.3 | 1248 | 9 | 753 | 5/6 | 1.0000 | não suportado | 3.3 / 150.7; 14.5 | 2224 | 2.7 | 3.3 | 1029 | 0.9905 |
| macOS arm64 · 26 | 8.1 / 462.1 | onnxruntime-node, protobufjs | 28.0 | 1835 | 8.4 | 699 | 5/6 | 1.0000 | não suportado | 4.2 / 150.7; 14.5 | 1973 | 2.8 | 5 | 955 | 0.9905 |
| Windows x64 · 22 | 8.2 / 472.7 | nenhum | 4.8 | 1101 | 14.5 | 577 | 4/6 | 0.9939 | não suportado | 3.6 / 150.7; 14.5 | 1857 | 4.7 | 5 | 724 | 0.9904 |
| Windows x64 · 24 | 5.7 / 463.3 | onnxruntime-node, protobufjs | 3.0 | 659 | 47.6 | 633 | 4/6 | 0.9941 | não suportado | 1.9 / 150.7; 14.5 | 910 | 9.5 | 9 | 817 | 0.9904 |
| Windows x64 · 26 | 8.4 / 463.3 | onnxruntime-node, protobufjs | 37.8 | 890 | 16 | 569 | 4/6 | 0.9939 | não suportado | 3.1 / 150.7; 14.5 | 1396 | 5.6 | 5.5 | 769 | 0.9904 |
| Windows arm64 · 22 | 26.8 / 470 | nenhum | 5.4 | 1049 | 29.4 | 575 | 5/6 | 0.9949 | não suportado | 13.6 / 150.7; 14.5 | 1891 | 2.8 | 4.8 | 703 | 0.9898 |
| Windows arm64 · 24 | 30.8 / 460.6 | onnxruntime-node, protobufjs | 5.2 | 991 | 29.5 | 623 | 5/6 | 0.9949 | não suportado | 15.2 / 150.7; 14.5 | 1353 | 2.8 | 4.9 | 768 | 0.9898 |
| Windows arm64 · 26 | 41.5 / 460.6 | onnxruntime-node, protobufjs | 21.9 | 1014 | 29.9 | 568 | 5/6 | 0.9949 | não suportado | 17.8 / 150.7; 14.5 | 1368 | 2.9 | 5 | 727 | 0.9898 |

### E. Pacote e `npx` (bundle de 1 arquivo vs dependências normais)

| célula | npm | tarball KB (bundle / deps) | `npx <tarball>` frio (ms) bundle / deps | `npx` quente (ms) bundle / deps | `npm i <tarball>` (ms; MB) bundle / deps | `--version` (ms) b / d | processo novo `search` (ms) b / d | MCP: initialize (ms) b / d | MCP: 1ª resposta de tool (ms) b / d | bin shim |
|---|---|---|---|---|---|---|---|---|---|---|
| Linux x64 · 22 | 10.9.9 | 157.9 / 9.4 | 968 / 1326 | 583 / 566 | 284; 0.5 / 751; 14.6 | 56.5 / 31.9 | 66.1 / 65.6 | 117.9 / 167 | 125.6 / 175.1 | ok / ok |
| Linux x64 · 24 | 11.19.1 | 157.9 / 9.4 | 790 / 1110 | 470 / 454 | 246; 0.5 / 640; 14.6 | 50.7 / 28.9 | 60.3 / 58.4 | 95.5 / 141.7 | 102.2 / 149.2 | ok / ok |
| Linux x64 · 26 | 11.20.0 | 157.9 / 9.4 | 655 / 1105 | 456 / 451 | 243; 0.5 / 624; 14.6 | 49.2 / 25.2 | 56.6 / 53.7 | 93.1 / 135.3 | 99.8 / 143.1 | ok / ok |
| Linux arm64 · 22 | 10.9.9 | 157.9 / 9.4 | 1166 / 1404 | 570 / 577 | 289; 0.5 / 748; 14.6 | 49.9 / 28 | 59.6 / 63.4 | 108.9 / 165.8 | 116.7 / 173.8 | ok / ok |
| Linux arm64 · 24 | 11.19.1 | 157.9 / 9.4 | 804 / 1302 | 488 / 503 | 309; 0.5 / 767; 14.6 | 50.8 / 27.2 | 59.1 / 61.2 | 99.1 / 166.8 | 106.8 / 175.2 | ok / ok |
| Linux arm64 · 26 | 11.20.0 | 157.9 / 9.4 | 726 / 1303 | 514 / 512 | 294; 0.5 / 723; 14.6 | 46.8 / 24.7 | 54.6 / 56.4 | 96.6 / 158.4 | 104.2 / 167 | ok / ok |
| macOS arm64 · 22 | 10.9.9 | 157.9 / 9.4 | 1090 / 2093 | 756 / 711 | 592; 0.5 / 1357; 14.6 | 80.5 / 49.8 | 82.4 / 72.6 | 138.2 / 151.7 | 152.8 / 159.4 | ok / ok |
| macOS arm64 · 24 | 11.19.1 | 157.9 / 9.4 | 1129 / 1495 | 838 / 666 | 525; 0.5 / 939; 14.6 | 88.8 / 51.2 | 116.8 / 88.3 | 96.6 / 157.9 | 102.8 / 164.3 | ok / ok |
| macOS arm64 · 26 | 11.20.0 | 157.9 / 9.4 | 1037 / 1681 | 959 / 611 | 478; 0.5 / 1101; 14.6 | 85.1 / 54.1 | 88 / 66.6 | 131.4 / 144.6 | 138.6 / 151.7 | ok / ok |
| Windows x64 · 22 | 10.9.9 | 157.9 / 9.5 | 10741 / 17534 | 1384 / 1579 | 778; 0.5 / 20537; 14.6 | 92.5 / 62.6 | 107.7 / 138.9 | 172.4 / 302.8 | 183 / 320.6 | ok / ok |
| Windows x64 · 24 | 11.19.1 | 157.9 / 9.5 | 7391 / 17220 | 841 / 959 | 444; 0.5 / 12549; 14.6 | 61.9 / 38.5 | 69.6 / 76.4 | 91.9 / 153.2 | 97.7 / 159.4 | ok / ok |
| Windows x64 · 26 | 11.20.0 | 157.9 / 9.5 | 6483 / 13250 | 1094 / 1196 | 594; 0.5 / 10555; 14.6 | 67.8 / 43.4 | 79.5 / 88.4 | 116.8 / 205.2 | 125.4 / 213.3 | ok / ok |
| Windows arm64 · 22 | 10.9.9 | 157.9 / 9.5 | 8004 / 12930 | 1812 / 3028 | 1051; 0.5 / 10184; 14.6 | 150.2 / 115.2 | 161.5 / 209.8 | 217.7 / 375.3 | 229 / 386.1 | ok / ok |
| Windows arm64 · 24 | 11.19.1 | 157.9 / 9.5 | 7253 / 14079 | 1644 / 1752 | 985; 0.5 / 10811; 14.6 | 156.8 / 116.3 | 172.8 / 190.1 | 219.4 / 352.9 | 232 / 362.2 | ok / ok |
| Windows arm64 · 26 | 11.20.0 | 157.9 / 9.5 | 6459 / 21756 | 1409 / 1585 | 906; 0.5 / 14735; 14.6 | 136.2 / 102.1 | 148.8 / 165.8 | 187.3 / 302.2 | 196.6 / 310.6 | ok / ok |

### E2. Runtime de embeddings opcional instalado sob demanda no diretório de dados do usuário

| célula | diretório | sem runtime: erro limpo | `npx … embeddings install` (s; MB) | npm encontrado via | install direto (2ª vez, ms; via) | 1º uso c/ download do modelo (s) | uso em cache (ms): import + carga | acertou | núcleo `search` depois (ms) |
|---|---|---|---|---|---|---|---|---|---|
| Linux x64 · 22 | ~/.cache/cabecao/runtime | sim | 9.4; 732.5 | npm_execpath | 292; npm-cli ao lado do node | 2.5 | 106 + 1107 | sim | 68.1 |
| Linux x64 · 24 | ~/.cache/cabecao/runtime | sim | 9.0; 723.1 | npm_execpath | 247; npm-cli ao lado do node | 2.4 | 72 + 730 | sim | 57.9 |
| Linux x64 · 26 | ~/.cache/cabecao/runtime | sim | 9.0; 723.1 | npm_execpath | 372; npm-cli ao lado do node | 32.2 | 69 + 839 | sim | 58.1 |
| Linux arm64 · 22 | ~/.cache/cabecao/runtime | sim | 5.7; 471.8 | npm_execpath | 297; npm-cli ao lado do node | 2.6 | 97 + 1029 | sim | 59.2 |
| Linux arm64 · 24 | ~/.cache/cabecao/runtime | sim | 5.6; 462.4 | npm_execpath | 316; npm-cli ao lado do node | 2.6 | 85 + 859 | sim | 61.1 |
| Linux arm64 · 26 | ~/.cache/cabecao/runtime | sim | 5.6; 462.4 | npm_execpath | 306; npm-cli ao lado do node | 32.5 | 85 + 920 | sim | 58.6 |
| macOS arm64 · 22 | ~/.cache/cabecao/runtime | sim | 8.6; 471.5 | npm_execpath | 485; npm-cli ao lado do node | 5.1 | 195 + 1644 | sim | 210.3 |
| macOS arm64 · 24 | ~/.cache/cabecao/runtime | sim | 9.2; 462.1 | npm_execpath | 446; npm-cli ao lado do node | 4.8 | 110 + 848 | sim | 83.5 |
| macOS arm64 · 26 | ~/.cache/cabecao/runtime | sim | 9.2; 462.1 | npm_execpath | 543; npm-cli ao lado do node | 23.9 | 186 + 1290 | sim | 99.7 |
| Windows x64 · 22 | ~\Local\cabecao\runtime | sim | 43.1; 472.7 | npm_execpath | 1113; npm-cli ao lado do node | 3.0 | 183 + 1167 | sim | 105.5 |
| Windows x64 · 24 | ~\Local\cabecao\runtime | sim | 28.3; 463.3 | npm_execpath | 304; npm-cli ao lado do node | 2.5 | 73 + 653 | sim | 69.8 |
| Windows x64 · 26 | ~\Local\cabecao\runtime | sim | 28.3; 463.3 | npm_execpath | 447; npm-cli ao lado do node | 30.3 | 109 + 854 | sim | 80 |
| Windows arm64 · 22 | ~\Local\cabecao\runtime | sim | 27.8; 470 | npm_execpath | 802; npm-cli ao lado do node | 4.6 | 176 + 1049 | sim | 171.5 |
| Windows arm64 · 24 | ~\Local\cabecao\runtime | sim | 28.7; 460.6 | npm_execpath | 753; npm-cli ao lado do node | 4.3 | 144 + 993 | sim | 179 |
| Windows arm64 · 26 | ~\Local\cabecao\runtime | sim | 37.1; 460.6 | npm_execpath | 653; npm-cli ao lado do node | 22.6 | 129 + 1026 | sim | 155.3 |

### F. Watchers com 10 mil arquivos

| célula | fs.watch: cenários | fs.watch: pronto (ms) / RSS (MB) | fs.watch: latência mediana (ms) | chokidar: cenários | chokidar: pronto (ms) / RSS (MB) | chokidar: latência mediana (ms) | parcel: cenários | parcel: pronto (ms) / RSS (MB) | parcel: latência mediana (ms) | falhas |
|---|---|---|---|---|---|---|---|---|---|---|
| Linux x64 · 22 | 18/18 | 142 / 85 | 3 | 18/18 | 303 / 110 | 2 | 16/18 | 34 / 60 | 51 | parcel: mover_para_pasta_nova (1/2), pasta_nova_com_50_arquivos (0/50) |
| Linux x64 · 24 | 18/18 | 31 / 68 | 1 | 18/18 | 224 / 110 | 2 | 16/18 | 35 / 55 | 51 | parcel: mover_para_pasta_nova (1/2), pasta_nova_com_50_arquivos (0/50) |
| Linux x64 · 26 | 18/18 | 31 / 62 | 1 | 18/18 | 243 / 115 | 2 | 16/18 | 38 / 56 | 51 | parcel: mover_para_pasta_nova (1/2), pasta_nova_com_50_arquivos (0/50) |
| Linux arm64 · 22 | 18/18 | 126 / 83 | 2 | 18/18 | 290 / 107 | 3 | 16/18 | 38 / 57 | 51 | parcel: mover_para_pasta_nova (1/2), pasta_nova_com_50_arquivos (0/50) |
| Linux arm64 · 24 | 18/18 | 30 / 65 | 1 | 18/18 | 280 / 107 | 2 | 16/18 | 34 / 53 | 51 | parcel: mover_para_pasta_nova (1/2), pasta_nova_com_50_arquivos (0/50) |
| Linux arm64 · 26 | 18/18 | 26 / 60 | 1 | 18/18 | 282 / 112 | 2 | 16/18 | 34 / 55 | 51 | parcel: mover_para_pasta_nova (1/2), pasta_nova_com_50_arquivos (0/50) |
| macOS arm64 · 22 | 18/18 | 1 / 41 | 13 | 18/18 | 241 / 92 | 17 | 18/18 | 14 / 49 | 110 | nenhuma |
| macOS arm64 · 24 | 18/18 | 1 / 48 | 13 | 18/18 | 286 / 97 | 14 | 18/18 | 13 / 50 | 110 | nenhuma |
| macOS arm64 · 26 | 18/18 | 1 / 53 | 14 | 18/18 | 288 / 88 | 17 | 18/18 | 15 / 56 | 127 | nenhuma |
| Windows x64 · 22 | 13/18 | 1 / 34 | 2 | 18/18 | 1068 / 87 | 10 | 18/18 | 35 / 39 | 55 | fs.watch: rajada_500_modificacoes (352/500), rajada_300_criacoes (70/300), git_pull_200_substituicoes (130/200), pasta_nova_com_50_arquivos (19/50), rajada_500_no_mesmo_processo (1/500); fs.watch: 16 eventos sem nome de arquivo (estouro de buffer → pedir revarredura) |
| Windows x64 · 24 | 13/18 | 0 / 41 | 1 | 18/18 | 531 / 124 | 6 | 18/18 | 528 / 46 | 62 | fs.watch: rajada_500_modificacoes (231/500), rajada_300_criacoes (56/300), git_pull_200_substituicoes (121/200), pasta_nova_com_50_arquivos (19/50), rajada_500_no_mesmo_processo (1/500); fs.watch: 17 eventos sem nome de arquivo (estouro de buffer → pedir revarredura) |
| Windows x64 · 26 | 13/18 | 0 / 40 | 1 | 18/18 | 1449 / 83 | 11 | 18/18 | 30 / 44 | 63 | fs.watch: rajada_500_modificacoes (238/500), rajada_300_criacoes (53/300), git_pull_200_substituicoes (100/200), pasta_nova_com_50_arquivos (9/50), rajada_500_no_mesmo_processo (1/500); fs.watch: 19 eventos sem nome de arquivo (estouro de buffer → pedir revarredura) |
| Windows arm64 · 22 | 13/18 | 1 / 36 | 2 | 18/18 | 819 / 90 | 8 | 18/18 | 49 / 41 | 64 | fs.watch: rajada_500_modificacoes (458/500), rajada_300_criacoes (86/300), git_pull_200_substituicoes (142/200), pasta_nova_com_50_arquivos (29/50), rajada_500_no_mesmo_processo (1/500); fs.watch: 14 eventos sem nome de arquivo (estouro de buffer → pedir revarredura) |
| Windows arm64 · 24 | 13/18 | 1 / 41 | 2 | 18/18 | 913 / 121 | 9 | 18/18 | 46 / 46 | 64 | fs.watch: rajada_500_modificacoes (364/500), rajada_300_criacoes (56/300), git_pull_200_substituicoes (113/200), pasta_nova_com_50_arquivos (17/50), rajada_500_no_mesmo_processo (1/500); fs.watch: 18 eventos sem nome de arquivo (estouro de buffer → pedir revarredura) |
| Windows arm64 · 26 | 13/18 | 1 / 41 | 1 | 18/18 | 844 / 85 | 8 | 18/18 | 44 / 46 | 64 | fs.watch: rajada_500_modificacoes (357/500), rajada_300_criacoes (61/300), git_pull_200_substituicoes (122/200), pasta_nova_com_50_arquivos (17/50), rajada_500_no_mesmo_processo (1/500); fs.watch: 17 eventos sem nome de arquivo (estouro de buffer → pedir revarredura) |

Linux: limites inotify no runner: max_user_watches=129232, max_user_instances=128. Watches consumidos com 10 mil arquivos em 13 pastas (Linux x64, Node 24): fs.watch = 19, chokidar = 19, parcel = 19.

Instalação dos watchers (`chokidar` + `@parcel/watcher`): Linux x64 · 24: 760 ms, 1.4 MB, script bloqueado: @parcel/watcher@2.6.0 (install: node scripts/build-from-source.js) · Linux arm64 · 24: 780 ms, 1.3 MB, script bloqueado: @parcel/watcher@2.6.0 (install: node scripts/build-from-source.js) · macOS arm64 · 24: 1405 ms, 1.2 MB, script bloqueado: @parcel/watcher@2.6.0 (install: node scripts/build-from-source.js) · Windows x64 · 24: 1020 ms, 1.4 MB, script bloqueado: @parcel/watcher@2.6.0 (install: node scripts/build-from-source.js) · Windows arm64 · 24: 2873 ms, 1.4 MB, script bloqueado: @parcel/watcher@2.6.0 (install: node scripts/build-from-source.js)

### G. Agendamento por usuário (registrar → disparar → conferir execução → remover)

| célula | verificações |
|---|---|
| Linux x64 · 22 | ✓ systemd_analyze_verify (systemd 259 (259.9-0ubuntu0.1))<br>✓ systemd_user_disponivel (running; linger: Linger=yes)<br>✓ systemd_enable_timer<br>✓ systemd_start_executa (1 execução)<br>✓ systemd_disable<br>✓ crontab_disponivel (existe) |
| Linux x64 · 24 | ✓ systemd_analyze_verify (systemd 259 (259.9-0ubuntu0.1))<br>✓ systemd_user_disponivel (running; linger: Linger=yes)<br>✓ systemd_enable_timer<br>✓ systemd_start_executa (1 execução)<br>✓ systemd_disable<br>✓ crontab_disponivel (existe) |
| Linux x64 · 26 | ✓ systemd_analyze_verify (systemd 259 (259.9-0ubuntu0.1))<br>✓ systemd_user_disponivel (running; linger: Linger=yes)<br>✓ systemd_enable_timer<br>✓ systemd_start_executa (1 execução)<br>✓ systemd_disable<br>✓ crontab_disponivel (existe) |
| Linux arm64 · 22 | ✓ systemd_analyze_verify (systemd 255 (255.4-1ubuntu8.18))<br>✓ systemd_user_disponivel (running; linger: Linger=yes)<br>✓ systemd_enable_timer<br>✓ systemd_start_executa (1 execução)<br>✓ systemd_disable<br>✓ crontab_disponivel (existe) |
| Linux arm64 · 24 | ✓ systemd_analyze_verify (systemd 255 (255.4-1ubuntu8.18))<br>✓ systemd_user_disponivel (running; linger: Linger=yes)<br>✓ systemd_enable_timer<br>✓ systemd_start_executa (1 execução)<br>✓ systemd_disable<br>✓ crontab_disponivel (existe) |
| Linux arm64 · 26 | ✓ systemd_analyze_verify (systemd 255 (255.4-1ubuntu8.18))<br>✓ systemd_user_disponivel (running; linger: Linger=yes)<br>✓ systemd_enable_timer<br>✓ systemd_start_executa (1 execução)<br>✓ systemd_disable<br>✓ crontab_disponivel (existe) |
| macOS arm64 · 22 | ✓ plutil_lint<br>✓ plutil_lint_exemplo<br>✓ launchctl_bootstrap (gui/501)<br>✓ launchctl_kickstart_executa (1 execução)<br>✓ launchctl_print<br>✓ launchctl_bootout |
| macOS arm64 · 24 | ✓ plutil_lint<br>✓ plutil_lint_exemplo<br>✓ launchctl_bootstrap (gui/501)<br>✓ launchctl_kickstart_executa (1 execução)<br>✓ launchctl_print<br>✓ launchctl_bootout |
| macOS arm64 · 26 | ✓ plutil_lint<br>✓ plutil_lint_exemplo<br>✓ launchctl_bootstrap (gui/501)<br>✓ launchctl_kickstart_executa (1 execução)<br>✓ launchctl_print<br>✓ launchctl_bootout |
| Windows x64 · 22 | ✓ schtasks_create<br>✓ schtasks_query<br>✓ schtasks_run_executa (1 execução)<br>✓ schtasks_delete<br>✓ schtasks_tr_longo (/TR 464 chars → recusou) |
| Windows x64 · 24 | ✓ schtasks_create<br>✓ schtasks_query<br>✓ schtasks_run_executa (1 execução)<br>✓ schtasks_delete<br>✓ schtasks_tr_longo (/TR 464 chars → recusou) |
| Windows x64 · 26 | ✓ schtasks_create<br>✓ schtasks_query<br>✓ schtasks_run_executa (1 execução)<br>✓ schtasks_delete<br>✓ schtasks_tr_longo (/TR 464 chars → recusou) |
| Windows arm64 · 22 | ✓ schtasks_create<br>✓ schtasks_query<br>✓ schtasks_run_executa (1 execução)<br>✓ schtasks_delete<br>✓ schtasks_tr_longo (/TR 466 chars → recusou) |
| Windows arm64 · 24 | ✓ schtasks_create<br>✓ schtasks_query<br>✓ schtasks_run_executa (1 execução)<br>✓ schtasks_delete<br>✓ schtasks_tr_longo (/TR 466 chars → recusou) |
| Windows arm64 · 26 | ✓ schtasks_create<br>✓ schtasks_query<br>✓ schtasks_run_executa (1 execução)<br>✓ schtasks_delete<br>✓ schtasks_tr_longo (/TR 466 chars → recusou) |

### H. Escala em runner limpo do Actions (Node 24)

| SO | CPU (núcleos) | notas | vault MB | do zero (s) | varrer+ler / parse / banco (s) | pico RSS (MB) | banco (MB) | nada mudou mtime (ms) | nada mudou hash (ms) | 10 alteradas mtime (ms) | 10 alteradas hash (ms) | 5 removidas + 5 renomeadas (ms) | BM25 p50: raro / 2 termos comuns / frase longa (ms) | grafo 2 saltos (ms) | processo novo `search` (ms) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| macOS arm64 | Apple M1 (Virtual) (3) | 1000 | 2.8 | 0.7 | 0.1 / 0.2 / 0.3 | 80 | 6.1 | 95 | 163 | 165 | 170 | 147 | 0.12 / 3.63 / 22.94 | 0.07 | 116 |
| macOS arm64 | Apple M1 (Virtual) (3) | 10000 | 29.3 | 8.2 | 2.1 / 1.3 / 4.3 | 111 | 61.8 | 340 | 590 | 348 | 692 | 436 | 0.11 / 37.72 / 165.11 | 0.03 | 100 |
| macOS arm64 | Apple M1 (Virtual) (3) | 30000 | 87.4 | 26.6 | 8.3 / 3.2 / 13.9 | 152 | 184.5 | 474 | 3562 | 1048 | 3201 | 671 | 0.15 / 109.78 / 530.15 | 0.07 | 201 |
| Linux x64 | AMD EPYC 9V45 96-Core (4) | 1000 | 2.8 | 0.6 | 0.0 / 0.1 / 0.2 | 80 | 6.1 | 57 | 70 | 82 | 91 | 84 | 0.08 / 2.24 / 11.16 | 0.03 | 55 |
| Linux x64 | AMD EPYC 9V45 96-Core (4) | 10000 | 29.3 | 4.3 | 0.3 / 0.7 / 2.4 | 108 | 61.8 | 150 | 243 | 202 | 297 | 233 | 0.08 / 21.96 / 96.03 | 0.02 | 72 |
| Linux x64 | AMD EPYC 9V45 96-Core (4) | 30000 | 87.4 | 12.6 | 0.7 / 1.8 / 7.6 | 150 | 184.5 | 313 | 578 | 345 | 676 | 397 | 0.1 / 63.41 / 279.56 | 0.04 | 116 |
| Windows x64 | AMD EPYC 7763 64-Core (4) | 1000 | 2.8 | 1.0 | 0.1 / 0.2 / 0.4 | 65 | 6.1 | 151 | 260 | 214 | 301 | 197 | 0.24 / 6.1 / 21.12 | 0.09 | 113 |
| Windows x64 | AMD EPYC 7763 64-Core (4) | 10000 | 29.3 | 8.1 | 1.2 / 1.5 / 4.9 | 95 | 61.8 | 345 | 1135 | 508 | 1447 | 491 | 0.22 / 53.63 / 177.86 | 0.07 | 154 |
| Windows x64 | AMD EPYC 7763 64-Core (4) | 30000 | 87.4 | 26.1 | 3.3 / 4.3 / 17.2 | 99 | 184.5 | 810 | 3037 | 953 | 3125 | 939 | 0.25 / 145.06 / 521.04 | 0.1 | 240 |

### H2. Carga de vetores int8 (384d) do disco para a memória — runner limpo

| SO | vetores | formato no disco | carga (ms) | RAM a mais (MB) | pico RSS (MB) | busca top-10 (ms) |
|---|---|---|---|---|---|---|
| macOS arm64 | 100000 | arquivo | 19 | 37 | 89 | 66.5 |
| macOS arm64 | 100000 | sqlite-blob-por-chunk | 169.4 | 55 | 103 | 66.1 |
| macOS arm64 | 100000 | sqlite-blocos-1024 | 29.6 | 68 | 120 | 59.9 |
| macOS arm64 | 300000 | arquivo | 60.7 | 111 | 164 | 179.2 |
| macOS arm64 | 300000 | sqlite-blob-por-chunk | 517.2 | 138 | 186 | 165.7 |
| macOS arm64 | 300000 | sqlite-blocos-1024 | 65.1 | 183 | 235 | 138.6 |
| Linux x64 | 100000 | arquivo | 13.4 | 37 | 92 | 31.4 |
| Linux x64 | 100000 | sqlite-blob-por-chunk | 147.4 | 57 | 106 | 31.1 |
| Linux x64 | 100000 | sqlite-blocos-1024 | 31 | 69 | 124 | 31.6 |
| Linux x64 | 300000 | arquivo | 41 | 110 | 166 | 97.2 |
| Linux x64 | 300000 | sqlite-blob-por-chunk | 410.5 | 138 | 188 | 98.9 |
| Linux x64 | 300000 | sqlite-blocos-1024 | 79.8 | 180 | 235 | 97.2 |
| Windows x64 | 100000 | arquivo | 9.7 | 37 | 78 | 61.4 |
| Windows x64 | 100000 | sqlite-blob-por-chunk | 239 | 47 | 89 | 61.6 |
| Windows x64 | 100000 | sqlite-blocos-1024 | 43.8 | 48 | 98 | 61.5 |
| Windows x64 | 300000 | arquivo | 28.5 | 110 | 153 | 184.3 |
| Windows x64 | 300000 | sqlite-blob-por-chunk | 677.6 | 129 | 172 | 184.2 |
| Windows x64 | 300000 | sqlite-blocos-1024 | 122.2 | 156 | 198 | 185 |
