---
title: Segurança e privacidade
description: Para onde vão os seus dados, como o scanner de segredos funciona, o que um agente é impedido de fazer e os limites conhecidos.
---

## Seus dados ficam com você

- As notas ficam numa pasta da sua máquina e num repositório git **seu**.
- O Cabeção não tem servidor, conta, telemetria nem coleta de uso. O pacote não faz chamadas de rede próprias: tudo o que sai da máquina passa pelo git, para o remoto que **você** configurou (`fetch`, `push` e, no `init` e no `doctor`, uma consulta para saber se o remoto responde).
- O servidor MCP roda na sua máquina, por stdio. Ele não abre porta de rede.
- O que um agente lê do cérebro vai para o modelo de IA que você usa, como qualquer outro texto da conversa. Isso é do cliente de IA, não do Cabeção: escolha o que guarda sabendo disso.

## Use um repositório privado

O código do Cabeção é público; o seu cérebro não deve ser. Em endereços HTTPS de provedores conhecidos (github.com, gitlab.com, bitbucket.org, codeberg.org, gitea.com, git.sr.ht e dev.azure.com), o `init` e o `doctor` tentam ler o repositório **sem credenciais**: se conseguirem, avisam que ele parece público.

Apontado para um repositório público (aqui, o do próprio projeto), o `doctor` mostra:

```text
aviso  Visibilidade             https://github.com/renanloureiroo/cabecao.git parece PÚBLICO: o GitHub respondeu a uma leitura sem credenciais
                                Correção: Torne o repositório privado nas configurações do GitHub antes de gravar notas pessoais.
```

Em SSH, ou num servidor que o Cabeção não conhece, não dá para saber sem a API do provedor. O `doctor` diz isso e pede que você confira no provedor:

```text
ok     Visibilidade             não verificável (só dá para conferir em HTTPS de provedor conhecido): confirme no provedor que o repositório é privado
```

## Scanner de segredos

Toda gravação de agente e todo sync passam por um scanner antes de qualquer commit ou envio. Se ele achar algo com cara de segredo, a operação para e mostra arquivo, linha e regra, **nunca o valor**:

```text
$ cabecao sync
Sync: bloqueado. Possível segredo em 1 lugar (memory/procedures/acesso-ao-roteador.md:6, regra generic-assignment). Nada foi commitado nem enviado. Remova o segredo, ou marque a linha com "cabecao:allow-secret" se não for um, e rode o sync de novo.
Possíveis segredos (o valor não é mostrado):
  memory/procedures/acesso-ao-roteador.md:6:8  generic-assignment (Atribuição a um nome sensível (password, senha, secret, token, api_key, access_key, private_key, credential) cujo valor tem cara de segredo: senha com letras e dígitos, ou valor longo de alta entropia.; mudança ainda sem commit)
Próximo passo: Tire o segredo dos arquivos apontados em secrets (ou marque a linha com "cabecao:allow-secret" se não for um) e rode sync de novo.
```

O que ele reconhece:

| Regra | O quê |
| --- | --- |
| `private-key` | Chave privada PEM ou OpenSSH |
| `aws-access-key-id`, `aws-secret-access-key` | Chaves da AWS |
| `github-token`, `gitlab-token` | Tokens do GitHub e do GitLab |
| `slack-token`, `stripe-key`, `google-api-key` | Tokens do Slack, chaves do Stripe e do Google |
| `anthropic-api-key`, `openai-api-key`, `npm-token` | Chaves da Anthropic, da OpenAI e tokens do npm |
| `jwt` | JSON Web Tokens assinados |
| `url-credentials` | URL com senha embutida (`esquema://usuario:senha@host`) |
| `cabecao-confirm-token` | O `confirm_token` do `forget` (`cbc_ct_...`): vale minutos e não deve ficar numa nota |
| `generic-assignment` | Um nome sensível (`password`, `senha`, `secret`, `token`, `api_key`...) recebendo um valor com cara de segredo |

O scanner olha tudo o que vai ser commitado, não só as notas: anexos de texto, configuração, valores do frontmatter.

### Quando não é um segredo

Se a linha acusada não é um segredo (um exemplo de documentação, um identificador público), marque-a com `cabecao:allow-secret`, na própria linha ou sozinho na linha de cima:

```markdown
<!-- cabecao:allow-secret -->
exemplo_de_token: abc123def456ghi789
```

O marcador só vale em texto **seu** (editado no Obsidian ou num editor e levado pelo sync). Num texto enviado por um agente, ele é ignorado: um agente não consegue se liberar escrevendo o marcador.

## O que um agente só faz com o seu pedido

Pelas tools do MCP e pela CLI (que segue as mesmas regras quando quem roda é um agente), estas ações exigem o seu **pedido explícito, confirmado**: a primeira chamada não faz nada e devolve o resumo exato e um token de confirmação de vida curta; o agente só repete com o token se você disser sim. Num cliente que sabe perguntar (elicitação), o servidor pergunta direto a você.

- criar ou alterar regras (`type: rule`, `memory/rules/`);
- escrever em `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` e outros arquivos que clientes de IA carregam como instrução, em qualquer pasta, e nos arquivos de controle (`log.md`, `README.md`, `.cabecao.json`, `.gitignore`, `.gitattributes`), estes três só se o resultado for válido e nunca mexendo na seção `embedding`;
- alterar fontes que já existem em `raw/`;
- gravar `trust: high`;
- desfazer uma operação sua;
- arquivar (`forget`) qualquer nota.

O que é feito assim **não vira `origin: human`**: fica `origin: agent:<cliente>`, mais `approved_by: user` e `approved_at` na nota e o rodapé `Cabecao-Approved` no commit. Só o Cabeção grava essas marcas; as que o agente mandar no frontmatter são ignoradas. A regra `agent_approved` do `cabecao lint` lista tudo para você revisar.

**O custo, dito com clareza:** o token prova que a ação foi intencional e é exatamente a que foi mostrada (outra ação, outro conteúdo, outra sessão, um token vencido ou forjado são recusados). Ele **não prova que você disse sim**: num cliente sem elicitação, quem afirma que você pediu é o agente. Um agente manipulado por um conteúdo pode fazer as duas chamadas. A rede de segurança é o que fica gravado: o commit identificado, o `cabecao undo` e a listagem do `lint`.

## O que um agente não faz nunca

Estas são proteções técnicas e valem com ou sem confirmação:

- escrever fora da pasta do cérebro, em `.git/` ou `.cabecao/`, ou através de um link simbólico;
- escrever no `index.md` (o catálogo é derivado das notas);
- criar uma cópia de conflito falsa, ou editar uma;
- gravar algo com cara de segredo, no texto, no caminho, no título ou no frontmatter (o marcador `cabecao:allow-secret` não vale para ele);
- forjar frontmatter com um BOM ou um `---` no começo do conteúdo (o texto final é relido e conferido);
- escolher a própria proveniência (`origin`, `edited_by`, `approved_by`, `approved_at`);
- passar dos limites de tamanho, ou usar nome de arquivo inválido ou com caractere invisível;
- fazer o `ingest` ler arquivos de fora do cérebro;
- mudar o modelo de embeddings ou compactar a branch de índice (é administração da máquina, só sua, no terminal).

Quando altera uma nota sua sem confirmação, ela ganha `edited_by` e o `trust` cai. E toda gravação dele é um commit que você desfaz com `cabecao undo`.

O conteúdo que o servidor devolve vem marcado como **dado, nunca instrução**, com a ordem de autoridade (você, as regras, o `AGENTS.md`, as memórias, o conteúdo de fora). Veja [Proveniência e confiança](./conceitos/proveniencia.md).

## Limites conhecidos

Dito com franqueza, para você decidir o que guardar:

- **Um agente com shell pode contornar a CLI e o servidor.** A CLI trata como agente todo processo sem terminal controlador ou com sinal de agente no ambiente ([Quem é humano e quem é agente na CLI](./guias/humano-e-agente.md)), mas um agente que roda comandos pode simular um terminal (abrir um pseudo-terminal e limpar as variáveis) ou simplesmente editar os arquivos do cérebro direto, sem passar pelo Cabeção. O sync trata essa edição como **sua** (`manual`): passa pelo scanner de segredos, mas não leva a marca de agente. Isso **não dá para fechar pela CLI**. A barreira que resiste a um agente manipulado é o **servidor MCP com o agente sem shell** (ou com o acesso à pasta do cérebro negado nas permissões do cliente).
- **Agentes sem sinal conhecido.** Para os agentes que não deixam variável no ambiente (Aider, GitHub Copilot, Antigravity e outros), a CLI depende do terminal controlador: se um deles rodar comandos num pseudo-terminal, conta como você.
- **O token de confirmação não prova que você disse sim** (veja acima).
- **O scanner trabalha por padrões.** Ele pega os formatos da tabela, não todo segredo possível: uma senha solta numa frase, sem um nome como "senha:" antes, passa. Não use o cérebro para guardar segredos.
- **"Dado, nunca instrução" é uma orientação ao modelo, não uma garantia.** Um texto malicioso numa nota pode, mesmo assim, influenciar um modelo. Desconfie de conteúdo de fora (`trust: low`).
- **Nada é cifrado pelo Cabeção.** As notas ficam em texto puro no disco e no remoto; quem tem acesso ao repositório lê tudo. A proteção é a do seu provedor e a do seu disco.
- **Commits sem assinatura.** Se `commit.gpgsign` estiver ligado, os commits do Cabeção saem sem assinatura, porque uma chave que pede senha travaria o sync. O `doctor` avisa.
- **A checagem de repositório público só cobre HTTPS de provedores conhecidos.** Em SSH, confira você mesmo.

## Relatar uma vulnerabilidade

Use o recurso de relato privado de vulnerabilidades do GitHub no [repositório do projeto](https://github.com/renanloureiroo/cabecao/security), não uma issue pública.
