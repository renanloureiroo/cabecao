---
title: Respostas com um modelo de linguagem (opcional)
description: O cabecao ask e a tool ask respondem com citações conferidas, usando um provedor que você escolhe. Desligado por padrão; nada sai da máquina até você ativar.
sidebar_position: 11
---

O Cabeção busca bem: palavra-chave, significado, grafo, validade no tempo e proveniência. Quem escreve a resposta, normalmente, é o agente que você já usa, lendo o resultado do `search`. Com o **`cabecao ask`** (e a tool `ask` para os agentes), o Cabeção também pode **gerar a resposta**: ele busca os trechos, manda para um modelo de linguagem que **você** escolhe e **confere cada citação** antes de devolver.

:::info[Opcional e desligado por padrão]
Nada disso é necessário para usar o Cabeção, e nada sai da máquina até você rodar `cabecao llm on` num terminal, ver o que passa a sair e para onde, e confirmar. Sem ativar, o `cabecao ask` mostra os trechos que achou e como ativar, e a tool `ask` nem aparece para os agentes.
:::

## O que o `ask` faz

1. **Busca** como o `search` (híbrida quando a busca por significado está ligada), com `--as-of`, `--scope` e `--type`, e lê a seção de cada nota achada.
2. **Filtra o que pode sair** (veja abaixo) e monta o pedido: cada trecho vai rotulado (`S1`, `S2`...) com a validade e a proveniência, entre delimitadores com uma marca sorteada a cada pergunta. O caminho, o título e as seções da nota vão **dentro** do bloco delimitado (são dados, como o texto), e o conteúdo de fora vai com as palavras separadas por `^`.
3. **Chama o provedor** ativado nesta máquina, pedindo a resposta em JSON: cada afirmação com as fontes e uma citação literal.
4. **Confere cada citação**: o rótulo tem de existir e a citação literal tem de estar no trecho citado (sem diferença de acento, caixa, aspas ou espaços). A citação tem de ser **substantiva**: pelo menos 16 letras ou números e 3 palavras de conteúdo; com reticências, no máximo 3 pedaços, cada um assim, na ordem. A citação que você vê é sempre o **texto real da nota**, nunca o que o modelo escreveu. O que não confere é descartado. Uma afirmação sem nenhuma citação conferida **não sai** (é texto livre do modelo): só conta em `unsupported_claims`. Sem nenhuma conferida, a resposta vira "o cérebro não tem isso"; com mais da metade descartada, o status é `low_confidence`, com só as conferidas e os trechos achados, para conferir. Duas afirmações que citam o mesmo trecho com citações diferentes ganham números diferentes, cada uma com a sua.

A resposta é **só lida**: nunca é gravada no cérebro, executada ou usada para chamar outra coisa. O texto do modelo é **escapado**: `[`, `]`, `<`, `>` e `\` saem com barra invertida, e nenhum renderizador de Markdown faz deles link, imagem ou HTML (num cliente que renderiza, uma imagem carregaria sozinha e levaria dados no endereço); endereços (com esquema, `//host`, `www.`, `host.tld/...` e domínios comuns) viram "(link removido)". O campo `missing` é uma linha curta (até 240 caracteres), também neutralizada, e o `data_notice` diz ao agente que a resposta é texto gerado por um modelo: dado, nunca instrução. A pergunta também é conferida: se o scanner de segredos acusar algo nela, nada é enviado.

:::note[O limite honesto]
O Cabeção **confere a citação, não a conclusão**: garante que o trecho citado existe e diz aquilo, não que a afirmação decorre dele. Para algo importante, abra a fonte.
:::

## Ativar

```bash
cabecao llm on
```

O comando procura o que já existe na sua máquina (o Claude Code instalado, uma variável `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` ou `GROQ_API_KEY`) e oferece isso primeiro. Você escolhe um número, confirma, e pronto. A chave, quando é preciso colar uma, é lida sem aparecer na tela.

Antes de ativar, ele mostra exatamente o que passa a sair e para onde. A saída abaixo é a da CLI de verdade, mas ilustrativa: no lugar do Ollama respondia um servidor local de teste, por isso o teste levou 0,0 s.

```text
$ cabecao llm on --provider ollama --model llama3.2

Para responder ao "cabecao ask" e à tool "ask" dos seus agentes, o Cabeção vai enviar a: Ollama nesta máquina (localhost:11434)
  Provedor "ollama" · modelo llama3.2 · roda nesta máquina

O que sai, a cada pergunta: a pergunta e até ~3000 tokens de trechos das notas que a busca achar,
  com o caminho, o título, o tipo, a validade e a proveniência (trust, origin) de cada um.
O que NUNCA sai: notas com "private: true" no frontmatter; arquivos de controle (catálogo, diário, AGENTS.md,
  CLAUDE.md e afins, cópias de conflito); qualquer trecho em que o scanner de segredos acusar algo (o trecho é
  omitido e a omissão aparece na resposta); o que a "llm_policy" do .cabecao.json do cérebro excluir; a chave.
A resposta nunca é gravada no cérebro nem executada: é só lida.

Custo: roda nesta máquina, sem cobrança por pergunta. Limites: até 2048 tokens de saída e ~3000 de contexto por pergunta, 60 s por chamada.
Para desligar: cabecao llm off. Para apagar o provedor: cabecao llm remove ollama.

Ativar? [s/N] s
Respostas ativadas com Ollama (servidor local) (modelo llama3.2).
Teste: funcionou em 0,0 s.
Pergunte com: cabecao ask "o que decidimos sobre ...?"
Nos agentes, a tool "ask" aparece na próxima sessão (reinicie o cliente de IA).
```

Ativar, desligar, testar, apagar e mudar a política é **com você, no terminal**: sem um terminal controlador, ou rodando por um agente, o `llm` recusa com o código 4 (veja [Quem é humano e quem é agente](./humano-e-agente.md)); só o `llm status` roda para todos, e para um agente ele diz apenas se as respostas estão ligadas. Um agente não ativa, não troca, não testa e não lê a chave, nem pela CLI nem por uma tool, nem com token de confirmação. O `cabecao ask` é de memória: um agente pode perguntar.

A confirmação do `llm on` fica **assinada** no `llm.json` com um segredo desta máquina (`llm-consent.key`, permissão `0600`) e cobre o destino, o modelo e de onde vem a chave. Um `llm.json` escrito à mão, copiado de outra máquina ou com o endereço trocado depois não ativa nada: rode `cabecao llm on` de novo.

### Onde fica a configuração

O `llm.json`, o segredo das confirmações, o contador do teto de gasto e as chaves em arquivo ficam na pasta de configuração **padrão do seu usuário** (`~/.config/cabecao`; no Windows, `%APPDATA%\cabecao`), calculada a partir do usuário do sistema. Se a pasta for desviada por variável de ambiente (`CABECAO_CONFIG_DIR`, `XDG_CONFIG_HOME`, `APPDATA` ou `HOME`), a configuração desviada vale **só para você, no terminal**; para um agente (que controla o ambiente dos comandos que roda), as respostas ficam desligadas e nada é lido. Assim um agente não aponta o `ask` para um `llm.json` que ele mesmo escreveu.

A "pasta do usuário do sistema" vem de `os.userInfo()`, que consulta a conta do sistema (no macOS e no Linux, o cadastro de usuários; no Windows, o perfil do usuário do processo), e não de `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME` ou `APPDATA`. E o **servidor MCP é sempre tratado como agente**, mesmo quando herda um terminal (um cliente de IA de terminal sobe o `cabecao mcp` como filho): ele nunca usa uma pasta desviada, nem a que a configuração MCP de um projeto apontar. O `ask.log` fica nessa mesma pasta, não na de cache.

### Provedores

| Provedor | Como ativar | Modelo padrão | Chave |
| --- | --- | --- | --- |
| **Claude Code** instalado | `cabecao llm on --provider claude-code` | `haiku` | Nenhuma: usa o login do Claude Code |
| Anthropic (API) | `cabecao llm on --provider anthropic` | `claude-haiku-5-5` | `ANTHROPIC_API_KEY` ou colar |
| OpenAI | `cabecao llm on --provider openai` | `gpt-6-luna` | `OPENAI_API_KEY` ou colar |
| Google Gemini (API) | `cabecao llm on --provider gemini` | `gemini-3.5-flash-lite` | `GEMINI_API_KEY` ou colar |
| OpenRouter | `cabecao llm on --provider openrouter --model <modelo>` | (escolha o seu) | `OPENROUTER_API_KEY` ou colar |
| Groq | `cabecao llm on --provider groq` | `openai/gpt-oss-20b` | `GROQ_API_KEY` ou colar |
| Ollama, nesta máquina | `cabecao llm on --provider ollama --model <modelo>` | (o que você baixou) | Nenhuma |
| LM Studio, nesta máquina | `cabecao llm on --provider lmstudio --model <modelo>` | (o que você carregou) | Nenhuma |
| Outro compatível com a API da OpenAI | `cabecao llm on --provider compatible --base-url <url> --model <modelo>` | (escolha o seu) | Opcional |

Os modelos padrão são os mais baratos com saída estruturada na documentação de cada provedor em 13/11/2026; troque com `--model`. O endereço (`--base-url`) só vale para `compatible`, `ollama` e `lmstudio`: os provedores de endereço fixo recusam, para o destino mostrado na confirmação ser sempre o real. Ele tem de ser `https`, ou `http` só nesta máquina (`localhost`, `127.0.0.1`, `[::1]`); endereços de rede de enlace e de metadados de nuvem (`169.254.*`, `fe80::`, `0.0.0.0`) são recusados, e o `llm.json` é conferido de novo a cada leitura. Para usar a chave de uma variável sem guardá-la, passe `--key-env NOME`.

O **Claude Code** entra porque a Anthropic documenta que o `claude -p` usa os limites da sua assinatura ([suporte da Anthropic](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), consultado em 13/11/2026). Para gerar a resposta ele roda **sem nenhuma ferramenta**: sem shell, sem leitura de arquivos, sem servidores MCP, sem as suas configurações, numa pasta temporária vazia e com tempo limite. Se o agente da sua conversa também é o Claude Code, cada `ask` abre uma segunda sessão (custa em dobro).

O `llm on` guarda o **caminho real** do `claude` que você confirmou (coberto pela assinatura), e o `ask` roda sempre esse, nunca o primeiro `claude` do PATH de quem pergunta. Quando quem pergunta é um agente, nada do ambiente dele muda o destino ou a configuração do `claude`: sem `ANTHROPIC_BASE_URL`, `CLAUDE_CONFIG_DIR`, chaves e os desvios para Bedrock, Vertex ou Foundry; `HOME` é a sua pasta do sistema; e o PATH só tem a pasta do `claude`, a do Node e as do sistema. Para você, no terminal, o seu ambiente vale.

### Por que o Antigravity instalado não é oferecido

A [FAQ do Antigravity](https://antigravity.google/docs/faq) (consultada em 13/11/2026) diz que embrulhar o `agy` em outro aplicativo "is not supported under consumer plans" e que usar software de terceiros para acessá-lo viola os termos, com risco para a conta. Por isso o Cabeção não chama o `agy`. Para os modelos do Google, use a **API do Gemini com chave** (`--provider gemini`). O Codex também não é oferecido: a OpenAI só orienta chamá-lo de outro programa com chave de API (não com o login do ChatGPT), e com essa chave a API da OpenAI (`--provider openai`) faz o mesmo sem subir um agente.

## O que sai da máquina, e o que nunca sai

A cada pergunta, sai **para o provedor que você ativou**: a pergunta e até ~3.000 tokens de trechos das notas que a busca achar, com caminho, título, tipo, validade e proveniência. Com um servidor local (Ollama, LM Studio), nada sai da máquina, a não ser que o modelo seja um dos modelos "-cloud" do Ollama, que rodam no ollama.com (o `llm on` avisa).

**Nunca saem**, com qualquer provedor:

- **notas privadas**, e o nome delas (veja abaixo);
- notas com o frontmatter ilegível (na dúvida, não sai);
- arquivos de controle: o catálogo, o `log.md`, `AGENTS.md`, `CLAUDE.md` e afins, cópias de conflito;
- qualquer trecho em que o [scanner de segredos](../seguranca.md#scanner-de-segredos) acuse algo, procurado na **nota inteira** (um bloco de chave privada vale do `BEGIN` ao `END`, e o trecho que encosta nele também fica de fora), sem respeitar o `cabecao:allow-secret`, que libera a linha para o git, não para um provedor de fora;
- o que a política do cérebro excluir;
- a chave.

O que ficou de fora aparece na resposta ("Trechos não enviados ao provedor: 1 de nota privada"). E `cabecao ask "<pergunta>" --show-context` mostra exatamente o que **seria** enviado, sem enviar nada.

### O que conta como nota privada

Uma nota é privada, e nunca vai a provedor nenhum, quando o frontmatter tem:

- a chave `private`, sem diferenciar maiúsculas (`private`, `Private`, `PRIVATE`), com um valor verdadeiro: `true`, `yes`, `on`, `sim`, `verdadeiro`, `1`, em texto ou numa lista (`[true]`);
- ou a tag `private`, ou uma tag aninhada dela (`private/saude`), com ou sem `#`, em `tags` ou `tag`;
- ou, como no Obsidian, a tag `#private` (ou `#private/...`) no corpo da nota.

Não contam: `private` dentro de outro campo (`meta: {private: true}`), `cssclasses` e tags parecidas (`privado`, `#privateer`). Uma nota cujo frontmatter não dá para ler também não sai.

E o **nome** de uma nota privada não sai nem quando outra nota a cita: o título, os apelidos (`aliases` ou `alias`, em lista ou em texto), o caminho e o nome do arquivo dela, citados como **palavra inteira** (sem diferenciar maiúsculas nem acentos, e com `%20` como espaço), viram `[nota privada]` no texto, no título, nas seções e no caminho dos trechos que saem; ela nunca entra como nota relacionada pelo grafo. Um nome curto (menos de 6 letras e números, como "Ana") não é trocado dentro do texto, onde estragaria palavras e ainda o revelaria: o trecho que o cita como palavra inteira simplesmente não sai (conta em `omitted.private`).

O limite honesto: o Cabeção esconde o nome onde o reconhece. Uma menção parcial (só o sobrenome, um apelido que não está em `aliases`) e o **conteúdo** de uma nota privada copiado para outra nota não são detectados. O filtro também protege só o que o Cabeção recupera: o que o agente escreve na própria pergunta vai ao provedor como está.

### Política por cérebro

No `.cabecao.json` (que vale em todas as máquinas), o campo `llm_policy` restringe o que um provedor recebe deste cérebro:

```json
{
  "llm_policy": {
    "allow": "agent",
    "exclude_paths": ["memory/private/**", "wiki/entities/Fulano.md"],
    "exclude_types": ["episode"],
    "exclude_trust": ["low"]
  }
}
```

| Campo | O que faz |
| --- | --- |
| `allow` | `"any"` (padrão): qualquer provedor ativado. `"agent"`: só o agente instalado. `"none"`: nunca chama provedor neste cérebro; o `ask` devolve só os trechos |
| `exclude_paths` | Caminhos que nunca saem (`*`, `**` e `?`; uma pasta vale para tudo dentro dela) |
| `exclude_types` | Tipos de nota que nunca saem |
| `exclude_trust` | Níveis de `trust` que nunca saem (por exemplo `["low"]`, o conteúdo ingerido) |

Sem o campo, o cérebro não restringe nada além do que a máquina configurou. Um `llm_policy` inválido **fecha**: nada é enviado, e o `doctor` diz o que corrigir.

A política **só restringe**: quem libera um provedor é sempre a configuração desta máquina (`cabecao llm on`); o cérebro só pode fechar mais. Mude com `cabecao llm policy` (só você, no terminal, com confirmação):

```bash
cabecao llm policy                          # mostra a política atual
cabecao llm policy --allow agent            # só o agente instalado
cabecao llm policy --exclude-path "memory/pessoal/**"
cabecao llm policy --clear                  # tira a política
```

Um agente **não muda** a `llm_policy`, nem pela CLI, nem por uma tool, nem com token de confirmação (como a seção `embedding`). Ela vai para o git e chega às outras máquinas pelo `sync`: uma política afrouxada em outra máquina (ou por quem tem escrita no remoto) afrouxa aqui também. Isso é aceito de propósito: quem escreve no remoto já consegue mudar as próprias notas, e cada máquina continua decidindo se ativa algum provedor.

## A política de dados de cada provedor

Consultadas em 13/11/2026. Confira a página atual antes de ativar:

| Provedor | O que a política diz | Fonte |
| --- | --- | --- |
| Anthropic (API) | Por padrão, não usa as entradas e saídas dos produtos comerciais para treinar modelos | [privacy.claude.com](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training) |
| Claude Code com Free, Pro ou Max | O uso para melhorar os modelos depende da sua configuração de privacidade na conta | [privacy.claude.com](https://privacy.claude.com/en/articles/10023580-is-my-data-used-for-model-training) |
| OpenAI | Não usa os dados da API para treinar, sem opt-in; registros de abuso por até 30 dias | [developers.openai.com](https://developers.openai.com/api/docs/guides/your-data) |
| Google Gemini (API) | **Camada gratuita:** usa o que você envia para melhorar os produtos, e pessoas podem ler. **Camada paga:** não usa; guarda registros por tempo limitado para detectar abuso | [aistudio.google.com](https://aistudio.google.com/docs/terms) |
| OpenRouter | Não guarda prompts nem respostas sem você ativar o registro; o Cabeção pede só provedores que não coletam dados (`provider.data_collection: "deny"`, que a referência de roteamento descreve como "use only providers which do not collect user data") | [registro](https://openrouter.ai/docs/guides/privacy/data-collection), [roteamento](https://openrouter.ai/docs/guides/routing/provider-selection) |
| Groq | Não retém os dados das requisições por padrão; pode registrar por até 30 dias para investigar erro ou abuso | [console.groq.com](https://console.groq.com/docs/your-data) |
| Ollama, LM Studio | Rodam na sua máquina | — |

:::warning[Gemini na camada gratuita]
Na camada gratuita da API do Gemini, os trechos das suas notas podem ser lidos por revisores do Google e usados para melhorar os produtos dele. O `llm on --provider gemini` avisa e pergunta se a sua chave é de um projeto com faturamento ativo. Para notas pessoais, use a camada paga.
:::

## Custos

- **APIs (Anthropic, OpenAI, Gemini, OpenRouter, Groq):** quem paga é você, na conta do provedor, por token. Uma pergunta manda ~3.000 tokens de contexto e recebe algumas centenas. Para um teto de gasto, configure-o no painel do provedor.
- **Claude Code:** sai dos limites da sua assinatura (ou da chave que o Claude Code usar). Na execução de teste deste guia, uma pergunta custou US$ 0,0017 com o `haiku`, segundo o próprio Claude Code.
- **Servidor local:** sem cobrança por pergunta.

Os limites ficam em `limits` no [`llm.json`](../referencia/arquivos.md#provedor-de-respostas-llmjson): por pergunta, `context_tokens` (padrão 3000, até 8000), `max_output_tokens` (2048) e `timeout_ms` (60000); e um **teto de gasto**: `max_calls_per_hour` (padrão 30, contando todas as perguntas desta máquina) e `max_calls_per_session` (padrão 20 por sessão do servidor MCP, isto é, por cliente de IA aberto). Com o teto atingido, o `ask` devolve `unavailable` (`limit_reached`) com os trechos achados, sem chamar o provedor: um agente em laço não esvazia a sua conta. Erros passageiros (limite de uso, servidor fora) têm até duas novas tentativas, e uma falha de conexão, no máximo uma, dentro do tempo limite. Um redirecionamento do servidor nunca é seguido: a chave e os trechos não vão a outro endereço.

O teto conta **perguntas** e é reservado **antes** de chamar o provedor, de forma atômica (uma trava no arquivo `ask-usage.json`, que vale entre processos: a CLI e cada servidor MCP aberto): 35 perguntas ao mesmo tempo não passam do teto. A vaga só volta quando nenhum pedido saiu (sem trecho para mandar, provedor não instalado, política). E cada pergunta faz **no máximo 3 pedidos** ao provedor, somando as novas tentativas, o segundo pedido quando o formato veio errado e o recuo para o provedor seguinte.

## Perguntar

```bash
cabecao ask "Que fila o Projeto Atlas usa hoje e por quê?"
```

Execução real com o Claude Code (`haiku`) no cérebro de exemplo do projeto, com `--verbose`:

```text
Hoje o Projeto Atlas usa SQS como fila. A migração de RabbitMQ para SQS ocorreu em maio de 2026, com status vigente. [1]
O motivo registrado para a troca foi o custo operacional de manter o RabbitMQ, que o time operava por conta própria. A decisão está resumida na fonte de reunião de arquitetura de 2026-05-03. [1]
O RabbitMQ foi a fila do Projeto Atlas de janeiro a maio de 2026, mas esse fato está vencido e não vale mais como resposta atual. [2]
A migração em andamento é de novembro de 2026: dois dos cinco consumidores do Projeto Atlas passaram a ler do SQS em lotes de 10 mensagens. [3]
A leitura em lote foi registrada como migração de novembro de 2026, mas as notas não dizem qual fila os três consumidores restantes usam nem quando eles migram. [3]

Faltou no cérebro: As notas não trazem o conteúdo da seção "Consequência" da síntese sobre SQS, que é embutida na linha do tempo. Também não dizem qual fila os três consumidores restantes do Projeto Atlas usam hoje, nem se eles já foram migrados. Os trechos não detalham as razões técnicas além do custo operacional.

Fontes:
  [1] memory/facts/fato-atlas-usa-sqs.md · vigente · trust high · origin agent:claude-code
      "O Projeto Atlas migrou de RabbitMQ para SQS em maio de 2026 por custo operacional."
  [2] memory/facts/fato-atlas-usa-rabbitmq.md · vencido · trust high · origin human
      "O Projeto Atlas usou RabbitMQ como fila de janeiro a maio de 2026."
  [3] memory/episodes/2026/11/2026-11-10-migracao-dos-consumidores.md › Migração dos consumidores para leitura em lote · vigente · trust medium · origin agent:claude-code
      "Dois dos cinco consumidores do [[Projeto Atlas]] passaram a ler do [[SQS]] em lotes de 10."
3 citação(ões) descartadas: rótulo inexistente ou texto que não está no trecho.

Diagnóstico (só para você; o agente não vê):
  provedor: claude-code · modelo haiku · destino: Anthropic, pelo Claude Code instalado (com o login da sua conta)
  busca: keyword · trechos recuperados 11 · enviados 11
  tokens: entrada 2 · saída 1615 · custo US$ 0,0017 · 8,4 s
```

Repare nas três citações descartadas: o modelo citou trechos em que a frase não estava, e o Cabeção tirou essas citações em vez de confiar nelas. (Nessa execução, a contagem de tokens de entrada ainda não somava a parte lida do cache; isso já foi corrigido.)

No terminal, cada afirmação aparece assim que chega inteira e conferida; as fontes vêm no fim. Com `--json`, sai o mesmo objeto que a tool `ask` devolve aos agentes, sem o nome do provedor nem do modelo (`--verbose` acrescenta um bloco `diagnostics`, só para você no terminal: para um agente, a opção é ignorada).

| Código de saída | Quando |
| --- | --- |
| `0` | O comando funcionou: respondeu, respondeu com pouco apoio (`low_confidence`) ou o cérebro não tem isso (`not_found`); o `status` do `--json` diz qual |
| `5` | Nenhum provedor gerou a resposta (desligado, falhou ou teto atingido): mostra os trechos achados |
| `2` | Erro de uso |

Os códigos 3 e 4 ficam de fora de propósito: em toda a CLI, eles querem dizer "pede o seu pedido explícito" e "só você, no terminal".

Ctrl+C cancela a pergunta e encerra o provedor (inclusive o processo do Claude Code e o que ele tiver aberto).

## Nos agentes: a tool `ask`

Com um provedor ativado, o servidor MCP passa a anunciar a tool [`ask`](../referencia/mcp.md#ask), logo depois de `search`. O agente manda só a pergunta e as opções de busca; ele não escolhe nem vê o provedor ou o modelo, e a resposta tem sempre o mesmo formato. Se o provedor falhar, a tool devolve `unavailable` com os trechos achados, e o agente responde sozinho. A tool aparece na próxima sessão: reinicie o cliente de IA depois do `llm on`.

**O que um agente vê do provedor: nada.** Nem o nome, nem o modelo, nem o destino, nem a mensagem de erro do provedor, por nenhum caminho: a tool `ask`, o `cabecao ask` (com `--verbose` ou `--show-context`), o `llm status` (só "ligadas" ou "desligadas"), o `status` e o `doctor`. Esses detalhes aparecem só para você, no terminal. A skill `cabecao-consultar` ensina o agente a usar o `ask` pela CLI do mesmo jeito.

## Onde fica a chave

| Sistema | Onde |
| --- | --- |
| macOS | Keychain, serviço `cabecao` (gravada pelo comando `security`, com a chave pela entrada padrão, nunca na linha de comando) |
| Linux | Secret Service, pelo `secret-tool` (libsecret), quando ele existe; senão, o arquivo protegido |
| Windows | Cifrada com a DPAPI do seu usuário do Windows, em `%APPDATA%\cabecao\credentials.dpapi.json` |
| Qualquer um, com `--store file` | `~/.config/cabecao/credentials.json`, com permissão `0600` |

A variável de ambiente do provedor, quando definida, vale antes do que está guardado. A chave nunca vai para o cérebro, para o `llm.json`, para o log ou para uma mensagem de erro, e o `llm status` mostra só os quatro últimos caracteres. Atenção: um servidor MCP iniciado pelo cliente de IA pode não herdar as variáveis do seu terminal; para o `ask` dos agentes, prefira guardar a chave.

No Windows, para cifrar ou decifrar com a DPAPI, a chave passa pelo **ambiente do processo do PowerShell** que o Cabeção abre por alguns instantes (nunca pela linha de comando). Enquanto ele roda, outro programa do **mesmo usuário** do Windows pode ler esse ambiente; programas de outros usuários, não. É o mesmo limite de uma chave numa variável de ambiente.

Atrás de um proxy: o `fetch` do Node só usa o `HTTPS_PROXY` quando isso é ligado. O Cabeção liga sozinho onde o Node permite (`http.setGlobalProxyFromEnv`), sempre com os endereços desta máquina em `NO_PROXY`: um servidor local (Ollama, LM Studio) **nunca** vai por túnel ao proxy. Com `NODE_USE_ENV_PROXY=1` e sem `localhost,127.0.0.1` no `NO_PROXY`, o Cabeção recusa chamar o servidor local e diz como corrigir. O `llm status` diz o que vale na sua máquina.

A chave guardada fica amarrada ao destino (a conta no cofre é `<provedor>@<endereço>`): trocar o endereço do provedor não entrega a chave a outro servidor. O arquivo de chaves é fechado (`0600`) antes de receber a chave, e uma pasta de configuração que outros usuários da máquina podem alterar é recusada.

## Ver, testar, desligar e apagar

```bash
cabecao llm status          # provedores, modelo, destino, onde está a chave (mascarada)
cabecao llm test            # uma chamada mínima, sem nada do cérebro: funcionou? quanto demorou?
cabecao llm off             # desliga: nada mais sai; a configuração e a chave continuam
cabecao llm remove openai   # apaga o provedor e a chave que o Cabeção guardou (pede confirmação)
cabecao llm policy          # a política de envio deste cérebro (veja acima)
```

Se o cofre do sistema recusar apagar a chave, o `llm remove` diz isso e sai com erro, em vez de dizer "apagado". O [`cabecao uninstall`](./atualizar.md) também apaga a configuração das respostas e as chaves guardadas (no cofre e no arquivo).

O `cabecao status` e o `cabecao doctor` mostram uma linha neutra "Respostas (ask)" (ligadas, desligadas, ou opcional e desligado). O provedor nunca aparece no fim do `init` nem na lista de opcionais: ativar é sob demanda, quando você quiser.

## Medir

```bash
cabecao eval --answers fixtures/eval/respostas.jsonl
```

Mede, com as suas perguntas: citações válidas, afirmações sem apoio, fonte certa citada, recusa correta (pergunta que o cérebro não responde, marcada com `"answerable": false`) e recusa indevida, com tempo e tokens. Cada pergunta é uma chamada ao provedor. Veja [`cabecao eval`](../referencia/cli.md#cabecao-eval---answers).

## Limites conhecidos

- **Testado:** o fluxo inteiro com um provedor falso, os dois adaptadores contra servidores locais que imitam as APIs, e uma execução real com o Claude Code. **Não testado com chaves reais** de Anthropic, OpenAI, Gemini, OpenRouter e Groq, nem com o cofre real de cada sistema (os testes usam um executor falso; no Windows, a DPAPI é testada de verdade).
- **Citação colada de frases diferentes.** Até 3 pedaços com reticências, cada um substantivo e na ordem do trecho, contam como uma citação: dá para montar uma citação real com pedaços de frases diferentes do mesmo trecho e apoiar nela uma conclusão que o trecho não tira.
- **A verificação confere a citação, não a conclusão.** Uma afirmação pode citar um trecho verdadeiro e tirar dele uma conclusão errada. Para algo importante, abra a fonte (`cabecao search`, ou `read` com o `id` da citação).
- **A assinatura da confirmação protege contra um `llm.json` forjado, não contra quem lê os seus arquivos.** Um agente com shell que lê a sua pasta de usuário pode ler o segredo local, assim como pode ler as suas notas direto. A proteção vale para o caminho que o Cabeção controla: a CLI e as tools.
- **A política do cérebro viaja pelo git.** Quem tem escrita no remoto pode afrouxá-la (veja acima); cada máquina continua decidindo se ativa um provedor.
- **"Dado, nunca instrução" continua sendo uma orientação ao modelo.** O conteúdo vai delimitado, o de fora vai marcado, e a resposta não executa nada; mesmo assim, um texto malicioso pode influenciar a resposta. A verificação das citações limita o estrago.
