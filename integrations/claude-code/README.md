# Plugin do Claude Code

O plugin liga o Cabeção ao Claude Code sem configuração manual. Ele traz quatro coisas:

- **o servidor MCP do Cabeção, embutido**: as 17 tools (`recall`, `search`, `remember`, `handoff_save`...), mais o `ask` quando você ativa um provedor, sobem com `node`, a partir do bundle que vem dentro do plugin, sem `npx` e sem rede (0,05 s por início, contra 1,4 s do `npx`);
- **o hook de início de sessão**: roda `cabecao recall --hook` e põe no contexto do agente as regras de uso e o briefing do cérebro (suas regras, o último handoff, preferências, armadilhas e memórias do projeto), marcado como dado e abaixo de 10 mil caracteres;
- **o hook de fim de sessão**: roda `cabecao sync --hook`, que dispara o sync num processo em segundo plano e volta na hora (o Claude Code dá só 1,5 s a esse hook);
- **as skills do Cabeção** (fonte: [`integrations/skills/`](../skills/)), copiadas para `skills/` no passo de versão: o plugin corresponde à versão publicada.

Nenhum hook lê, copia ou grava a conversa. O que entra no cérebro é só o que o agente grava pelas tools, como sem o plugin.

## Instalar

Antes: Node.js 22.16+ ou 24+ no `PATH` e um cérebro nesta máquina (`npx cabecao init <url>`, ou uma pasta de cérebro que você vai informar).

Dentro do Claude Code:

```text
/plugin marketplace add renanloureiroo/cabecao
/plugin install cabecao@cabecao
```

No Claude Code 2.1.275 ou mais novo, um passo só também funciona: `/plugin install cabecao --marketplace renanloureiroo/cabecao`. Pelo terminal: `claude plugin marketplace add renanloureiroo/cabecao` e `claude plugin install cabecao@cabecao`.

### Pasta do cérebro

O plugin tem uma opção, `brain_dir`. Vazia, vale o cérebro padrão desta máquina (o que o `cabecao init` gravou em `~/.config/cabecao`). Para outra pasta:

```bash
claude plugin install cabecao@cabecao --config brain_dir=/caminho/do/cerebro
```

ou, depois de instalado, `/plugin configure cabecao@cabecao` dentro do Claude Code.

### Se você já usou `cabecao install-client claude-code`

O plugin registra o próprio servidor MCP (`plugin:cabecao:cabecao`). Tire o registro antigo para não ter as tools em dobro:

```bash
cabecao install-client --remove claude-code
```

## O que os hooks fazem

| Quando | Comando | O que acontece |
|---|---|---|
| A sessão começa (também em `resume`, `clear` e `compact`) | `cabecao recall --hook` | Lê o JSON da sessão, deriva o escopo `project:<pasta>` da pasta do projeto e devolve o briefing em `hookSpecificOutput.additionalContext`. Sem cérebro ou com qualquer erro, devolve `{}` e a sessão começa normalmente. |
| A sessão termina | `cabecao sync --hook` | Dispara `cabecao sync --log` num processo destacado, que sobrevive ao Claude Code fechar, e volta em milissegundos. O resultado vai para `<cérebro>/.cabecao/logs/sync.log`. |

O que eles **não** fazem: não capturam prompts, respostas nem chamadas de tools; não bloqueiam o encerramento para pedir um handoff (o handoff fica por conta das regras de uso); não usam rede além do `git push`/`pull` do próprio sync.

## Como o bundle chega ao plugin

O Claude Code instala um plugin de marketplace clonando o repositório e copiando a pasta do plugin, sem passo de build, e não copia nada de fora dela. Por isso o bundle da CLI (`packages/cli/dist`) vai **commitado** em `server/`, gerado por:

```bash
pnpm build:plugin   # build da CLI + scripts/build-plugin.mjs
```

O script copia os arquivos, grava `server/build.json` (versão e SHA-256 de cada arquivo) e acerta a `version` do `.claude-plugin/plugin.json` com a do pacote `cabecao`. Ele roda sozinho no PR "Version Packages" (`pnpm version-packages`, chamado pelo workflow `release`), então o plugin da `main` é sempre o da última versão. O teste `packages/cli/test/plugin.test.ts` falha quando o bundle fica com outra versão que a do pacote ou quando algum arquivo não bate com o `build.json`. Como a `version` muda a cada versão do pacote, o `/plugin update` só oferece atualização quando sai uma versão nova.

## Testar localmente

```bash
pnpm build:plugin
claude plugin validate .                      # marketplace e plugin
claude --plugin-dir integrations/claude-code  # uma sessão com o plugin, sem instalar
```

Para não mexer na sua configuração do Claude Code, use uma pasta de configuração temporária: `CLAUDE_CONFIG_DIR=$(mktemp -d) claude plugin marketplace add .` e `... claude plugin install cabecao@cabecao`.

## Problemas

- O servidor não conecta (`claude mcp list` mostra `plugin:cabecao:cabecao ... Failed to connect`): rode `cabecao doctor`; confira se o `node` do `PATH` é 22.16+ ou 24+ e se `brain_dir` aponta para um cérebro.
- O briefing não aparece: rode à mão `echo '{}' | node <pasta do plugin>/server/cabecao.mjs recall --hook`; o motivo sai no stderr.
- O sync do fim de sessão: veja `<cérebro>/.cabecao/logs/sync.log`.
