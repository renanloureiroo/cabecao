---
title: Troubleshooting
description: Use doctor and fix the most common errors, about credentials, conflicts, locks, Node version, and the wrong folder.
---

## Start with doctor

```bash
cabecao doctor
```

It checks the Cabeção version, Node.js, git, the brain, the machine configuration, the git identity, the remote and the credential, `.gitignore`, the local database, semantic search, locks, interrupted operations, conflicts, the registration in AI clients, the skills, the scheduled sync, and the `ask` answer provider. Each item comes out as `ok`, `aviso` (warning), or `falha` (failure), with the fix next to it. The exit code is 1 if there is any failure.

Offline, or to be quick, use `cabecao doctor --offline`: it does not query the remote.

```text
$ cabecao doctor --offline --brain ~/pasta-qualquer
Diagnóstico do Cabeção: ~/pasta-qualquer

ok     Cabeção                  1.0.0 (instalado com npm -g); para atualizar: npm i -g cabecao@latest
ok     Node.js                  v24.21.0
ok     git                      2.54.0
falha  Cérebro                  não achei .cabecao.json em ~/pasta-qualquer: a pasta não é um cérebro do Cabeção. Rode "cabecao init".
                                Correção: Confira o caminho do cérebro ou rode "cabecao init".
ok     Configuração da máquina  máquina "notebook"
ok     Respostas (ask)          opcional e desligado: nada sai da máquina ("cabecao llm on" ativa)

5 ok, 0 avisos, 1 falha.
```

## Credentials: "Sem permissão para acessar"

```text
$ cabecao init https://github.com/voce-exemplo-inexistente/cerebro.git
cabecao: consultando o remoto...
O cérebro não foi criado: Sem permissão para acessar https://github.com/voce-exemplo-inexistente/cerebro.git. O Cabeção usa as credenciais que o seu git já usa (chave SSH, token salvo, gerenciador de credenciais) e nunca pede senha. Teste no terminal: git ls-remote https://github.com/voce-exemplo-inexistente/cerebro.git Nada foi criado nesta máquina.
O que fazer: o Cabeção usa as credenciais do seu git e nunca pede senha. Configure uma chave SSH (com o ssh-agent) ou salve um token no gerenciador de credenciais, confira com "git ls-remote <url>" e repita.
Saída do git:
  fatal: could not read Username for 'https://github.com': terminal prompts disabled
Ou comece só local agora: rode "cabecao init" sem a URL.
```

Cabeção runs git without a terminal, so it cannot ask for a username and password, and git fails with "Sem permissão para acessar" (no permission to access). What to do:

- **SSH:** use the `git@...` address, with the key loaded in `ssh-agent`.
- **HTTPS:** save a token in git's credential manager (on macOS, the Keychain; on Windows, Git Credential Manager).
- Check in the terminal with `git ls-remote <url>`. If it responds without asking for anything, Cabeção can too.

If the repository does not exist or the address is wrong, the message is different: "Não achei um repositório git em ..." (no git repository found at ...). Copy the address from the provider's "clone" button.

## Offline

```text
$ cabecao sync
Sync: remoto indisponível. Remoto origin indisponível: não consegui falar com o remoto (sem rede, servidor fora do ar ou tempo esgotado). As mudanças ficaram em commits locais e vão no próximo sync.
```

Nothing was lost. Run `cabecao sync` again when the network is back.

## Pending conflict

`status` shows `Conflitos pendentes: 1` and `doctor` gives a warning. Merge the `.conflict-*` copy into the original note and delete the copy; see [Resolve a conflict](./guias/resolver-conflito.md).

## Sync blocked by a secret

Sync stops with `Sync: bloqueado. Possível segredo em ...` and gives the file, line, and rule. Remove the secret from the file or, if it is not one, mark the line with `cabecao:allow-secret`. See [Security](./seguranca.md#secret-scanner).

## Lock or interrupted operation

- **Another sync running:** `cabecao sync` exits with 0 without doing anything. Wait for it to finish.
- **Orphan lock** (a process died holding the lock): `doctor` shows `Travas` (locks) as a warning. The next sync or write takes over Cabeção's lock on its own. If it is git's `index.lock`, delete it by hand when no git is running.
- **Sync interrupted midway** (the computer shut down): run `cabecao sync`; it recovers the state on its own, without losing anything.
- **Half-finished git operation** (a `merge` or `rebase` of yours in the brain folder): sync refuses to continue. Finish the operation or undo it with `git merge --abort` (or `git rebase --abort`) in the brain folder.
- **`locked` error in a tool:** another process held the lock for too long. Nothing was changed; the agent can try again.

## Old Node.js

```text
$ cabecao --version
cabecao precisa de Node.js 22.16+ ou 24+. Versão atual: v20.12.2. Atualize em https://nodejs.org
```

Install Node.js 24 (LTS). The 23 line is not accepted either. If you use a version manager (nvm, fnm, Volta), keep in mind that AI clients may see a different Node: the registration made by a global install points straight at the Node that was active during `install-client`. After switching versions, run `cabecao install-client --all` again.

## The folder is not a brain

```text
$ cabecao status
cabecao: nenhum cérebro configurado nesta máquina
Passe --brain <pasta>, defina CABECAO_BRAIN, entre na pasta de um cérebro ou rode "cabecao init".
```

```text
$ cabecao status --brain ~/pasta-qualquer
cabecao: não achei .cabecao.json em ~/pasta-qualquer: a pasta não é um cérebro do Cabeção. Rode "cabecao init".
Rode "cabecao init" nesta pasta ou aponte para a pasta de um cérebro.
```

The brain is chosen in this order: `--brain`, `CABECAO_BRAIN`, the default saved by `init`, the current folder. On a new machine, run `cabecao init`.

## Init refused the repository

- **"parece um projeto de código"** (looks like a code project): the repository has `package.json`, `src/`, or another marker. Use a repository just for the brain.
- **"A pasta ... já existe e não está vazia"** (the folder already exists and is not empty): pick with `--dir` a folder that does not exist yet (or an empty one). If it is your Obsidian vault, don't empty anything: put the vault in a remote repository and run `cabecao init <url>`, which clones it into a new folder ([Adopt an existing vault](./guias/adotar-vault.md)).

## The agent does not see Cabeção

1. Run `cabecao doctor` and look at the `Clientes MCP` item.
2. If the client is not registered, run `cabecao install-client <cliente>`.
3. **Restart the client.** Clients only read their configuration at startup.

## Odd local database

Results that do not match the notes, or the `index_failed` error: run `cabecao reindex --full` (or delete `.cabecao/cabecao.db`, which does not go to git, and run `cabecao status`). The database is rebuilt from the notes.

## Report a problem

Open an [issue](https://github.com/renanloureiroo/cabecao/issues) with the output of `cabecao doctor --offline` and, if there is an error, the output with `CABECAO_DEBUG=1`. **Do not include content from your brain.**
