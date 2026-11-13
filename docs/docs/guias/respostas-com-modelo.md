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
2. **Filtra o que pode sair** (veja abaixo) e monta o pedido: cada trecho vai rotulado (`S1`, `S2`...) com o caminho, a validade e a proveniência, entre delimitadores com uma marca sorteada a cada pergunta.
3. **Chama o provedor** ativado nesta máquina, pedindo a resposta em JSON: cada afirmação com as fontes e uma citação literal.
4. **Confere cada citação**: o rótulo tem de existir e a citação literal tem de estar no trecho citado (sem diferença de acento, caixa, aspas ou espaços). O que não confere é descartado; a afirmação sem nenhuma citação conferida aparece marcada `[sem apoio]`; sem nenhuma, a resposta vira "o cérebro não tem isso".

A resposta é **só lida**: nunca é gravada no cérebro, executada ou usada para chamar outra coisa.

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

Ativar e trocar de provedor é **com você, no terminal**: sem um terminal interativo, ou rodando dentro de um agente, o `llm on` recusa. Um agente não ativa, não troca e não lê a chave, nem pela CLI nem por uma tool.

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

Os modelos padrão são os mais baratos com saída estruturada na documentação de cada provedor em 13/11/2026; troque com `--model`. O endereço de um serviço compatível tem de ser `https`, ou `http` só em `localhost`. Para usar a chave de uma variável sem guardá-la, passe `--key-env NOME`.

O **Claude Code** entra porque a Anthropic documenta que o `claude -p` usa os limites da sua assinatura ([suporte da Anthropic](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), consultado em 13/11/2026). Para gerar a resposta ele roda **sem nenhuma ferramenta**: sem shell, sem leitura de arquivos, sem servidores MCP, sem as suas configurações, numa pasta temporária vazia e com tempo limite. Se o agente da sua conversa também é o Claude Code, cada `ask` abre uma segunda sessão (custa em dobro).

### Por que o Antigravity instalado não é oferecido

A [FAQ do Antigravity](https://antigravity.google/docs/faq) (consultada em 13/11/2026) diz que embrulhar o `agy` em outro aplicativo "is not supported under consumer plans" e que usar software de terceiros para acessá-lo viola os termos, com risco para a conta. Por isso o Cabeção não chama o `agy`. Para os modelos do Google, use a **API do Gemini com chave** (`--provider gemini`). O Codex também não é oferecido: a OpenAI só orienta chamá-lo de outro programa com chave de API (não com o login do ChatGPT), e com essa chave a API da OpenAI (`--provider openai`) faz o mesmo sem subir um agente.

## O que sai da máquina, e o que nunca sai

A cada pergunta, sai **para o provedor que você ativou**: a pergunta e até ~3.000 tokens de trechos das notas que a busca achar, com caminho, título, tipo, validade e proveniência. Com um servidor local (Ollama, LM Studio), nada sai da máquina, a não ser que o modelo seja um dos modelos "-cloud" do Ollama, que rodam no ollama.com (o `llm on` avisa).

**Nunca saem**, com qualquer provedor:

- notas com `private: true` no frontmatter;
- arquivos de controle: o catálogo, o `log.md`, `AGENTS.md`, `CLAUDE.md` e afins, cópias de conflito;
- qualquer trecho em que o [scanner de segredos](../seguranca.md#scanner-de-segredos) acuse algo (sem respeitar o `cabecao:allow-secret`, que libera a linha para o git, não para um provedor de fora);
- o que a política do cérebro excluir;
- a chave.

O que ficou de fora aparece na resposta ("Trechos não enviados ao provedor: 1 de nota privada"). E `cabecao ask "<pergunta>" --show-context` mostra exatamente o que **seria** enviado, sem enviar nada.

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

## A política de dados de cada provedor

Consultadas em 13/11/2026. Confira a página atual antes de ativar:

| Provedor | O que a política diz | Fonte |
| --- | --- | --- |
| Anthropic (API) | Por padrão, não usa as entradas e saídas dos produtos comerciais para treinar modelos | [privacy.claude.com](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training) |
| Claude Code com Free, Pro ou Max | O uso para melhorar os modelos depende da sua configuração de privacidade na conta | [privacy.claude.com](https://privacy.claude.com/en/articles/10023580-is-my-data-used-for-model-training) |
| OpenAI | Não usa os dados da API para treinar, sem opt-in; registros de abuso por até 30 dias | [developers.openai.com](https://developers.openai.com/api/docs/guides/your-data) |
| Google Gemini (API) | **Camada gratuita:** usa o que você envia para melhorar os produtos, e pessoas podem ler. **Camada paga:** não usa; guarda registros por tempo limitado para detectar abuso | [aistudio.google.com](https://aistudio.google.com/docs/terms) |
| OpenRouter | Não guarda prompts nem respostas sem você ativar o registro; o Cabeção pede só provedores que não coletam dados (`data_collection: "deny"`) | [openrouter.ai](https://openrouter.ai/docs/guides/privacy/data-collection) |
| Groq | Não retém os dados das requisições por padrão; pode registrar por até 30 dias para investigar erro ou abuso | [console.groq.com](https://console.groq.com/docs/your-data) |
| Ollama, LM Studio | Rodam na sua máquina | — |

:::warning[Gemini na camada gratuita]
Na camada gratuita da API do Gemini, os trechos das suas notas podem ser lidos por revisores do Google e usados para melhorar os produtos dele. O `llm on --provider gemini` avisa e pergunta se a sua chave é de um projeto com faturamento ativo. Para notas pessoais, use a camada paga.
:::

## Custos

- **APIs (Anthropic, OpenAI, Gemini, OpenRouter, Groq):** quem paga é você, na conta do provedor, por token. Uma pergunta manda ~3.000 tokens de contexto e recebe algumas centenas. Para um teto de gasto, configure-o no painel do provedor.
- **Claude Code:** sai dos limites da sua assinatura (ou da chave que o Claude Code usar). Na execução de teste deste guia, uma pergunta custou US$ 0,0017 com o `haiku`, segundo o próprio Claude Code.
- **Servidor local:** sem cobrança por pergunta.

Os limites por pergunta ficam em `limits` no [`llm.json`](../referencia/arquivos.md#provedor-de-respostas-llmjson): `context_tokens` (padrão 3000, até 8000), `max_output_tokens` (2048) e `timeout_ms` (60000). Erros passageiros (limite de uso, servidor fora, rede) têm até duas novas tentativas, dentro do tempo limite.

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

No terminal, cada afirmação aparece assim que chega inteira e conferida; as fontes vêm no fim. Com `--json`, sai o mesmo objeto que a tool `ask` devolve aos agentes, sem o nome do provedor nem do modelo (`--verbose` acrescenta um bloco `diagnostics`, só para você).

| Código de saída | Quando |
| --- | --- |
| `0` | Respondeu, com citações conferidas |
| `3` | O cérebro não tem isso |
| `4` | Mais da metade das afirmações ficou sem apoio |
| `5` | Nenhum provedor disponível: mostra os trechos achados e como ativar |
| `2` | Erro de uso |

Ctrl+C cancela a pergunta e encerra o provedor (inclusive o processo do Claude Code e o que ele tiver aberto).

## Nos agentes: a tool `ask`

Com um provedor ativado, o servidor MCP passa a anunciar a tool [`ask`](../referencia/mcp.md#ask), logo depois de `search`. O agente manda só a pergunta e as opções de busca; ele não escolhe nem vê o provedor ou o modelo, e a resposta tem sempre o mesmo formato. Se o provedor falhar, a tool devolve `unavailable` com os trechos achados, e o agente responde sozinho. A tool aparece na próxima sessão: reinicie o cliente de IA depois do `llm on`.

## Onde fica a chave

| Sistema | Onde |
| --- | --- |
| macOS | Keychain, serviço `cabecao` (gravada pelo comando `security`, com a chave pela entrada padrão, nunca na linha de comando) |
| Linux | Secret Service, pelo `secret-tool` (libsecret), quando ele existe; senão, o arquivo protegido |
| Windows | Cifrada com a DPAPI do seu usuário do Windows, em `%APPDATA%\cabecao\credentials.dpapi.json` |
| Qualquer um, com `--store file` | `~/.config/cabecao/credentials.json`, com permissão `0600` |

A variável de ambiente do provedor, quando definida, vale antes do que está guardado. A chave nunca vai para o cérebro, para o `llm.json`, para o log ou para uma mensagem de erro, e o `llm status` mostra só os quatro últimos caracteres. Atenção: um servidor MCP iniciado pelo cliente de IA pode não herdar as variáveis do seu terminal; para o `ask` dos agentes, prefira guardar a chave.

Atrás de um proxy: o `fetch` do Node só usa o `HTTPS_PROXY` quando isso é ligado. O Cabeção liga sozinho onde o Node permite (`http.setGlobalProxyFromEnv`); no Node 24, `NODE_USE_ENV_PROXY=1` também vale. O `llm status` diz o que vale na sua máquina.

## Ver, testar, desligar e apagar

```bash
cabecao llm status          # provedores, modelo, destino, onde está a chave (mascarada)
cabecao llm test            # uma chamada mínima, sem nada do cérebro: funcionou? quanto demorou?
cabecao llm off             # desliga: nada mais sai; a configuração e a chave continuam
cabecao llm remove openai   # apaga o provedor e a chave que o Cabeção guardou (pede confirmação)
```

O `cabecao status` e o `cabecao doctor` também mostram uma linha "Respostas (ask)".

## Medir

```bash
cabecao eval --answers fixtures/eval/respostas.jsonl
```

Mede, com as suas perguntas: citações válidas, afirmações sem apoio, fonte certa citada, recusa correta (pergunta que o cérebro não responde, marcada com `"answerable": false`) e recusa indevida, com tempo e tokens. Cada pergunta é uma chamada ao provedor. Veja [`cabecao eval`](../referencia/cli.md#cabecao-eval---answers).

## Limites conhecidos

- **Testado:** o fluxo inteiro com um provedor falso, os dois adaptadores contra servidores locais que imitam as APIs, e uma execução real com o Claude Code. **Não testado com chaves reais** de Anthropic, OpenAI, Gemini, OpenRouter e Groq, nem com o cofre real de cada sistema (os testes usam um executor falso; no Windows, a DPAPI é testada de verdade).
- **A verificação confere a citação, não o raciocínio.** Uma afirmação pode citar um trecho verdadeiro e tirar dele uma conclusão errada. Para algo importante, abra a fonte (`cabecao search`, ou `read` com o `id` da citação).
- **"Dado, nunca instrução" continua sendo uma orientação ao modelo.** O conteúdo vai delimitado, o de fora vai marcado, e a resposta não executa nada; mesmo assim, um texto malicioso pode influenciar a resposta. A verificação das citações limita o estrago.
