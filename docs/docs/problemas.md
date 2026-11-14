---
title: Solução de problemas
description: Use o doctor e resolva os erros mais comuns, de credencial, conflito, trava, versão do Node e pasta errada.
---

## Comece pelo doctor

```bash
cabecao doctor
```

Ele confere a versão do Cabeção, Node.js, git, o cérebro, a configuração da máquina, a identidade do git, o remoto e a credencial, o `.gitignore`, o banco local, a busca por significado, travas, operações interrompidas, conflitos, o registro nos clientes de IA, as skills, o sync agendado e o provedor de respostas do `ask`. Cada item sai como `ok`, `aviso` ou `falha`, com a correção ao lado. O código de saída é 1 se houver alguma falha.

Sem rede, ou para ser rápido, use `cabecao doctor --offline`: ele não consulta o remoto.

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

## Credencial: "Sem permissão para acessar"

```text
$ cabecao init https://github.com/voce-exemplo-inexistente/cerebro.git
cabecao: consultando o remoto...
O cérebro não foi criado: Sem permissão para acessar https://github.com/voce-exemplo-inexistente/cerebro.git. O Cabeção usa as credenciais que o seu git já usa (chave SSH, token salvo, gerenciador de credenciais) e nunca pede senha. Teste no terminal: git ls-remote https://github.com/voce-exemplo-inexistente/cerebro.git Nada foi criado nesta máquina.
O que fazer: o Cabeção usa as credenciais do seu git e nunca pede senha. Configure uma chave SSH (com o ssh-agent) ou salve um token no gerenciador de credenciais, confira com "git ls-remote <url>" e repita.
Saída do git:
  fatal: could not read Username for 'https://github.com': terminal prompts disabled
Ou comece só local agora: rode "cabecao init" sem a URL.
```

O Cabeção roda o git sem terminal, então ele não pode perguntar usuário e senha. O que fazer:

- **SSH:** use o endereço `git@...`, com a chave carregada no `ssh-agent`.
- **HTTPS:** salve um token no gerenciador de credenciais do git (no macOS, o Keychain; no Windows, o Git Credential Manager).
- Confira no terminal com `git ls-remote <url>`. Se ele responder sem pedir nada, o Cabeção também consegue.

Se o repositório não existe ou o endereço está errado, a mensagem é outra: "Não achei um repositório git em ...". Copie o endereço do botão "clonar" do provedor.

## Sem rede

```text
$ cabecao sync
Sync: remoto indisponível. Remoto origin indisponível: não consegui falar com o remoto (sem rede, servidor fora do ar ou tempo esgotado). As mudanças ficaram em commits locais e vão no próximo sync.
```

Nada se perdeu. Rode `cabecao sync` de novo quando a rede voltar.

## Conflito pendente

O `status` mostra `Conflitos pendentes: 1` e o `doctor` dá um aviso. Junte a cópia `.conflict-*` com a nota original e apague a cópia; veja [Resolver um conflito](./guias/resolver-conflito.md).

## Sync bloqueado por segredo

O sync para com `Sync: bloqueado. Possível segredo em ...` e diz arquivo, linha e regra. Tire o segredo do arquivo ou, se não for um, marque a linha com `cabecao:allow-secret`. Veja [Segurança](./seguranca.md#scanner-de-segredos).

## Trava ou operação interrompida

- **Outro sync rodando:** o `cabecao sync` sai com 0 sem fazer nada. Espere ele terminar.
- **Trava órfã** (um processo morreu segurando a trava): o `doctor` mostra `Travas` como aviso. O próximo sync ou gravação toma a trava do Cabeção sozinho. Se for o `index.lock` do git, apague-o à mão quando nenhum git estiver rodando.
- **Sync interrompido no meio** (o computador desligou): rode `cabecao sync`; ele recupera o estado sozinho, sem perder nada.
- **Operação do git pela metade** (um `merge` ou `rebase` seu na pasta do cérebro): o sync se recusa a continuar. Termine a operação ou desfaça com `git merge --abort` (ou `git rebase --abort`) na pasta do cérebro.
- **Erro `locked` numa tool:** outro processo segurou a trava por tempo demais. Nada foi alterado; o agente pode tentar de novo.

## Node.js antigo

```text
$ cabecao --version
cabecao precisa de Node.js 22.16 ou mais novo. Versão atual: v20.12.2. Atualize em https://nodejs.org
```

Instale o Node.js 24 (LTS). A linha 23 também não é aceita. Se você usa um gerenciador de versões (nvm, fnm, Volta), lembre que os clientes de IA podem enxergar outro Node: o registro feito por uma instalação global aponta direto para o Node que estava ativo no `install-client`. Depois de trocar de versão, rode `cabecao install-client --all` de novo.

## A pasta não é um cérebro

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

O cérebro é escolhido nesta ordem: `--brain`, `CABECAO_BRAIN`, o padrão gravado pelo `init`, a pasta atual. Numa máquina nova, rode `cabecao init`.

## O init recusou o repositório

- **"parece um projeto de código"**: o repositório tem `package.json`, `src/` ou outro marcador. Use um repositório só para o cérebro.
- **"A pasta ... já existe e não está vazia"**: escolha com `--dir` uma pasta que ainda não existe (ou vazia). Se é o seu vault do Obsidian, não esvazie nada: ponha o vault num repositório remoto e rode `cabecao init <url>`, que clona numa pasta nova ([Adotar um vault existente](./guias/adotar-vault.md)).

## O agente não vê o Cabeção

1. Rode `cabecao doctor` e veja o item `Clientes MCP`.
2. Se o cliente não está registrado, rode `cabecao install-client <cliente>`.
3. **Reinicie o cliente.** Os clientes só leem a configuração ao iniciar.

## Banco local estranho

Resultados que não batem com as notas, ou o erro `index_failed`: rode `cabecao reindex --full` (ou apague `.cabecao/cabecao.db`, que não vai para o git, e rode `cabecao status`). O banco é refeito a partir das notas.

## Relatar um problema

Abra uma [issue](https://github.com/renanloureiroo/cabecao/issues) com a saída do `cabecao doctor --offline` e, se houver erro, a saída com `CABECAO_DEBUG=1`. **Não inclua conteúdo do seu cérebro.**
