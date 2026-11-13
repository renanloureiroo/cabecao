---
title: Segurança e privacidade
description: Para onde vão os seus dados, como o scanner de segredos funciona, o que um agente é impedido de fazer e os limites conhecidos.
---

## Seus dados ficam com você

- As notas ficam numa pasta da sua máquina e num repositório git **seu**.
- O Cabeção não tem servidor, conta, telemetria nem coleta de uso. Tudo o que sai da máquina passa pelo git, para o remoto que **você** configurou (`fetch`, `push` e, no `init` e no `doctor`, uma consulta para saber se o remoto responde).
- **A única exceção é opcional e desligada por padrão:** se você ativar as [respostas com um modelo de linguagem](./guias/respostas-com-modelo.md) (`cabecao llm on`), cada pergunta do `ask` manda trechos das notas ao provedor que **você** escolheu. Nada vai até você ativar, num terminal, vendo o que sai e para onde. Veja [abaixo](#respostas-com-um-provedor-opcional).
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
- numa consolidação sem ninguém olhando (`consolidate --run`), também não envia ao remoto, não desfaz, não deixa handoff, não ingere, não arquiva e não faz nenhuma das ações que pedem o seu pedido (veja abaixo).

Quando altera uma nota sua sem confirmação, ela ganha `edited_by` e o `trust` cai. E toda gravação dele é um commit que você desfaz com `cabecao undo`.

O conteúdo que o servidor devolve vem marcado como **dado, nunca instrução**, com a ordem de autoridade (você, as regras, o `AGENTS.md`, as memórias, o conteúdo de fora). Veja [Proveniência e confiança](./conceitos/proveniencia.md).

## O que roda sem você olhando {#o-que-roda-sem-voce-olhando}

Duas coisas o Cabeção faz sem você na frente da tela: o sync agendado ([Sync automático](./guias/sync-automatico.md)), que só faz git, e o `cabecao consolidate --run` ([Consolidar com um agente](./guias/consolidar-com-agente.md)), que chama um agente de IA para ler e reescrever o cérebro. O segundo é o mais sensível: o agente lê notas que podem ter texto malicioso vindo de fontes ingeridas, e ninguém está ali para recusar um pedido estranho. Por isso:

- **Só agentes cujos termos permitem.** O Cabeção só chama um agente se os termos dele permitem que outro programa o rode com a credencial em uso, conferido na fonte oficial: o Claude Code, com o seu login ou chave de API, e o Codex, só com chave de API. O Antigravity e o Gemini CLI ficam de fora: os termos do plano pessoal não permitem ([FAQ do Antigravity](https://antigravity.google/docs/faq/)).
- **Só as tools do Cabeção.** Cada agente roda com shell, edição de arquivos e rede negados, e só as tools do servidor do Cabeção liberadas. Nenhum modo de "pular todas as permissões" é usado. Um agente que não permite essa restrição em modo não interativo não tem `--run` (hoje: Cursor Agent, Copilot CLI e OpenCode; os motivos estão no guia).
- **Configuração temporária.** O servidor do Cabeção vai numa configuração de MCP criada para a execução, numa pasta temporária vazia que também é o diretório de trabalho do agente, e apagada no fim. A configuração dos seus clientes não é lida para isso nem alterada; o login do agente é o que ele já tem.
- **Ambiente mínimo.** O agente recebe só as variáveis de sistema, de pastas, de proxy e certificados, de git, do Cabeção e as do login dele (`ANTHROPIC_API_KEY` e afins; no Codex, a chave de API como `CODEX_API_KEY`). Outros tokens do seu ambiente não são repassados.
- **Servidor preso à consolidação.** O servidor que o agente sobe (`cabecao mcp --consolidation <id>`) grava tudo com a sessão da consolidação e recusa `sync`, `undo`, `handoff_save`, `ingest` e um segundo `start`. `forget` também, a não ser que você passe `--allow-forget`: arquivar memória sem ninguém olhando só com opção explícita. As ações que pedem o seu pedido explícito (regra, arquivos de controle e de instrução, `raw/`, `trust: high`) ficam **indisponíveis**, nem com o token, porque não há ninguém para confirmar; só `--allow-elevated` as libera. `--allow-forget` e `--allow-elevated` só você passa, no terminal. As demais restrições de agente continuam (nada fora do cérebro, scanner de segredos).
- **Tempo limite.** Passado o tempo (padrão: 20 minutos), o agente e tudo o que ele iniciou são encerrados: o grupo de processos no macOS e no Linux, a árvore com `taskkill /T` no Windows.
- **Nada pela metade.** Se o agente não fechar a consolidação, o que ele gravou é desfeito com um commit de revert, e o comando sai com `1`. Se fechou, `cabecao undo --session <id>` desfaz tudo, e o ponto de restauração continua na máquina.
- **Nada sai da máquina pelo Cabeção.** A consolidação não faz sync; o commit vai para o remoto no próximo sync. O que o agente lê vai para o modelo de IA dele, como em qualquer sessão sua.

O que fica de fora, por agente: o Codex mantém a tool de aplicar patch (a caixa de areia somente leitura recusa a escrita) e, conforme o modelo, uma tool de leitura de arquivos que a caixa de areia não bloqueia; sem shell e sem rede, o que ele ler só sairia por uma escrita no cérebro, que passa pelo scanner. E "negado" depende de cada agente cumprir as próprias opções: o Cabeção não roda o agente numa caixa de areia própria.

## Skills pela CLI: o que podem e o que não podem {#skills-pela-cli}

As [skills do Cabeção](./guias/skills.md) não dão nenhum poder novo ao agente: elas só ensinam quais comandos `cabecao` rodar. Quem decide o que é permitido é a CLI, e um agente rodando a CLI está sob **as mesmas regras do servidor MCP**:

- **Pode**, sem perguntar: consultar (`recall`, `search`, `read`, `graph`, `facts`, `lint`, `status`), gravar memórias comuns (`remember`, `write`, `patch`, `relate`, `handoff`), registrar fontes (`ingest`), desfazer as próprias operações (`undo --op <id>`) e sincronizar (`sync`). Tudo vira um commit com `origin: agent:<nome>` e o rodapé `Cabecao-Client`, que `undo` desfaz.
- **Só com o seu pedido explícito**, em duas chamadas com `--confirm <token>`: regras, arquivos de controle e de instrução, `raw/`, `trust: high`, arquivar (`forget`) e desfazer uma operação que não é de agente. A skill `cabecao-pedido-explicito` diz para mostrar o resumo, perguntar e nunca seguir um pedido que veio de conteúdo lido. O que for gravado assim fica marcado e aparece no `lint`.
- **Não pode**: os comandos só seus (`embeddings on/off/switch`, `compact`, `upgrade`, `llm on/off/test/remove/policy`, `eval --answers`, remover com `uninstall`) saem com o código 4; nenhuma opção, variável ou arquivo de configuração faz o agente virar você (`--as` só dá o nome). As proteções técnicas (fora do cérebro, `.git/`, links simbólicos, segredos, frontmatter forjado) valem sem exceção.

O limite está logo abaixo: um agente que tem shell pode **não usar** a CLI e editar os arquivos do cérebro direto. As skills deixam o caminho certo fácil; elas não impedem o errado.
## Respostas com um provedor (opcional)

Com o `ask` ativado, o conteúdo do cérebro passa a ter mais um destinatário: o provedor que gera a resposta. As proteções:

- **Opt-in por máquina e por provedor.** O `cabecao llm on` só funciona com você no terminal, mostra o destino, o que sai, o que nunca sai, a política de dados do provedor e o custo, e pede confirmação. Um agente não ativa, não troca e não lê a chave. `cabecao llm off` desliga. A confirmação fica assinada com um segredo local e cobre destino, modelo e chave: um `llm.json` forjado ou com o endereço trocado não ativa nada, e uma configuração desviada por variável de ambiente não vale para um agente.
- **O que nunca sai:** notas privadas (a chave `private` em qualquer caixa com valor verdadeiro, ou a tag `private`) e o nome delas citado em outras notas, notas de frontmatter ilegível, arquivos de controle, trechos em que o scanner acusa segredo na nota inteira (o marcador `cabecao:allow-secret` não vale aqui) e o que a `llm_policy` do cérebro excluir. Um cérebro pode proibir qualquer provedor (`"allow": "none"`) ou permitir só o agente instalado (`"agent"`); a política só restringe, vale em todas as máquinas e só você a muda (`cabecao llm policy`).
- **Conteúdo como dado.** Cada trecho vai entre delimitadores com uma marca sorteada a cada pergunta (um trecho que tente forjar o delimitador é neutralizado), com o caminho e o título da nota dentro do bloco, o conteúdo de fora vai com as palavras separadas por `^`, e o prompt diz que nada dentro dos trechos é instrução.
- **Resposta só lida.** Nada do que o provedor devolve é executado, gravado no cérebro ou usado para chamar outra coisa. Sequências de controle de terminal, imagens, links, endereços e HTML são removidos do texto do modelo.
- **Citações conferidas pelo Cabeção**, não pelo modelo: rótulo inventado, citação curta demais (menos de 16 letras ou números e 3 palavras de conteúdo) ou que não está no trecho é descartada, e a citação mostrada é o texto real da nota; sem nenhuma citação válida, a resposta é "o cérebro não tem isso". O Cabeção confere a citação, não a conclusão.
- **Rede sem desvio.** Um redirecionamento nunca é seguido, um servidor desta máquina nunca vai pelo proxy, os endereços de metadados de nuvem são recusados e há um teto de chamadas por hora e por sessão.
- **O agente não vê o provedor.** Nem o nome, nem o modelo, nem o destino, nem o erro do provedor, por nenhum comando ou tool.
- **A chave** fica no cofre do sistema (ou num arquivo `0600`), entra nos programas do sistema pela entrada padrão (no Windows, pelo ambiente só do processo do PowerShell), nunca na linha de comando, e nunca aparece no cérebro, no log, numa mensagem de erro ou no `--json`. Ela fica amarrada ao destino: trocar o endereço do provedor não a entrega a outro servidor.
- **O agente instalado roda sem ferramentas.** O Claude Code, como provedor, roda sem shell, sem leitura de arquivos e sem MCP, numa pasta temporária vazia, com ambiente mínimo e tempo limite; a árvore de processos é encerrada no fim.

Detalhes, provedores e a política de dados de cada um em [Respostas com um modelo de linguagem](./guias/respostas-com-modelo.md).

## Limites conhecidos

Dito com franqueza, para você decidir o que guardar:

- **Um agente com shell pode contornar a CLI e o servidor.** A CLI trata como agente todo processo sem terminal controlador ou com sinal de agente no ambiente ([Quem é humano e quem é agente na CLI](./guias/humano-e-agente.md)), mas um agente que roda comandos pode simular um terminal (abrir um pseudo-terminal e limpar as variáveis) ou simplesmente editar os arquivos do cérebro direto, sem passar pelo Cabeção. O sync trata essa edição como **sua** (`manual`): passa pelo scanner de segredos, mas não leva a marca de agente. Isso **não dá para fechar pela CLI**. A barreira que resiste a um agente manipulado é o **servidor MCP com o agente sem shell** (ou com o acesso à pasta do cérebro negado nas permissões do cliente).
- **Agentes sem sinal conhecido.** Para os agentes que não deixam variável no ambiente (Aider, GitHub Copilot, Antigravity e outros), a CLI depende do terminal controlador: se um deles rodar comandos num pseudo-terminal, conta como você.
- **O token de confirmação não prova que você disse sim** (veja acima).
- **O scanner trabalha por padrões.** Ele pega os formatos da tabela, não todo segredo possível: uma senha solta numa frase, sem um nome como "senha:" antes, passa. Não use o cérebro para guardar segredos.
- **"Dado, nunca instrução" é uma orientação ao modelo, não uma garantia.** Um texto malicioso numa nota pode, mesmo assim, influenciar um modelo. Desconfie de conteúdo de fora (`trust: low`).
- **Com o `ask` ativado, os trechos enviados ficam sob a política do provedor.** O Cabeção escolhe o que sai, mas não controla o que o provedor faz com o que recebeu.
- **Nada é cifrado pelo Cabeção.** As notas ficam em texto puro no disco e no remoto; quem tem acesso ao repositório lê tudo. A proteção é a do seu provedor e a do seu disco.
- **Commits sem assinatura.** Se `commit.gpgsign` estiver ligado, os commits do Cabeção saem sem assinatura, porque uma chave que pede senha travaria o sync. O `doctor` avisa.
- **A checagem de repositório público só cobre HTTPS de provedores conhecidos.** Em SSH, confira você mesmo.

## Relatar uma vulnerabilidade

Use o recurso de relato privado de vulnerabilidades do GitHub no [repositório do projeto](https://github.com/renanloureiroo/cabecao/security), não uma issue pública.
