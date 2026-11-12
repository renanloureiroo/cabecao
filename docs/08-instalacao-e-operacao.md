# 08 · Instalação e operação

> 🚧 Comportamento planejado. Os comandos ainda não existem; o que está marcado como "testado" foi validado em prova de conceito.

## Requisitos

| Item | Versão | Observação |
|---|---|---|
| Node.js | 22.16 ou superior; recomendado 24 | Versões anteriores não têm busca por texto no SQLite embutido |
| git | 2.38 ou superior | Necessário para integrar sem tocar na pasta de trabalho |
| Um repositório git | Qualquer provedor, ou nenhum | De preferência privado |
| Obsidian | Opcional | Para visualizar |

Nada mais: sem Python, sem Docker, sem banco, sem compilador, sem conta em serviço.

## Instalar

```bash
npx cabecao init <url-do-repositório>
```

Exemplos de URL: `git@github.com:voce/cerebro.git`, `https://gitlab.com/voce/cerebro.git`, `git@bitbucket.org:voce/cerebro.git`, `ssh://servidor/git/cerebro.git`, `/Volumes/backup/cerebro.git`.

O que o `init` faz, sem perguntar mais nada:

1. Clona para `~/cabecao` (mude com `--dir`).
2. Reconhece o que há no repositório e age conforme a tabela de [04 · Sincronização](04-sincronizacao.md): cria, baixa ou adota.
3. Monta o índice local.
4. Registra o servidor MCP nos clientes encontrados.
5. Roda o `doctor` e mostra o resultado.

Sem URL, `npx cabecao init` cria um cérebro só local. Você liga o remoto depois com `cabecao remote <url>`.

O pacote tem cerca de 160 KB e nenhuma dependência. Primeiro `npx` medido: perto de 1 s no Linux e no macOS, de 6 a 11 s no Windows.

### Ativar a busca por significado

```bash
cabecao embeddings on [modelo]
```

É um passo separado e opcional; o `init` continua pedindo só a URL. Sem o nome do modelo, o comando mostra as sugestões testadas, com tamanho, qualidade e licença de cada uma, e pergunta qual você quer. A lista está em [06 · Busca e grafo](06-busca-e-grafo.md#escolha-do-modelo).

Depois ele baixa o runtime (cerca de 115 MB) e o modelo escolhido (de 118 a 570 MB) para o diretório de dados do usuário e calcula os embeddings do que ainda não tem. A escolha fica gravada no cérebro: numa segunda máquina, `cabecao embeddings on` usa o mesmo modelo sem perguntar, e os embeddings já vêm do repositório. Antes disso tudo, a busca por palavra-chave já funciona.

### Segunda máquina

O mesmo comando, com a mesma URL:

```bash
npx cabecao init git@gitlab.com:voce/meu-cerebro.git
```

## Clientes

### Claude Code: plugin
```text
/plugin marketplace add renanloureiroo/cabecao
/plugin install cabecao@cabecao
```
O plugin traz o servidor MCP embutido, o hook de início (briefing), o hook de fim (sync) e uma skill de referência. A pasta do cérebro é perguntada na instalação.

Testado com marketplace local; a instalação a partir do repositório público ainda não.

### Claude Code: sem plugin
`cabecao install-client claude-code` registra só o servidor MCP, com `claude mcp add-json`. Sem os hooks, as regras de uso chegam pelas instruções do servidor.

### Claude Desktop
Baixe `cabecao.mcpb` na página de versões do projeto e abra com dois cliques. Uma tela pede a pasta do cérebro. O pacote foi gerado e validado (242 KB); a instalação no aplicativo ainda não foi testada.

### Outros
```bash
cabecao install-client codex
cabecao install-client cursor
cabecao install-client vscode
cabecao install-client gemini
cabecao install-client --print     # só mostra a configuração
```

## Comandos

| Comando | O que faz |
|---|---|
| `cabecao init [url]` | Instala ou conecta uma máquina |
| `cabecao status` | Notas, último sync, conflitos, fila de embeddings |
| `cabecao doctor` | Diagnóstico com a correção sugerida para cada problema |
| `cabecao sync` | Sincroniza tudo |
| `cabecao search "<pergunta>"` | Busca pelo terminal |
| `cabecao ingest <arquivo>` | Registra uma fonte em `raw/` |
| `cabecao undo [--session\|--op]` | Desfaz |
| `cabecao lint` | Relatório de saúde |
| `cabecao consolidate` | Chama um agente não interativo para consolidar |
| `cabecao embeddings on [modelo]\|off\|status\|switch <modelo>` | Busca por significado, com o modelo que você escolher |
| `cabecao schedule on\|off` | Sync periódico pelo agendador do sistema |
| `cabecao compact` | Reduz o índice e inicia uma geração nova |
| `cabecao reindex [--full]` | Reconstrói o banco local |
| `cabecao obsidian setup` | Configura o vault para visualização |
| `cabecao eval` | Mede a busca com as suas perguntas |
| `cabecao remote <url>` | Liga ou troca o remoto |
| `cabecao upgrade` | Aplica migrações do esquema |
| `cabecao purge <id>` | Apaga definitivamente |
| `cabecao mcp` | Servidor MCP (usado pelos clientes) |
| `cabecao serve` | Servidor MCP por HTTP local |

## Sync automático

Não há daemon. O sync acontece:

- no fim de cada sessão do Claude Code, pelo hook do plugin;
- periodicamente, se você rodar `cabecao schedule on`, que registra uma tarefa no agendador do seu sistema, sem permissão de administrador:

| Sistema | Mecanismo |
|---|---|
| macOS | LaunchAgent |
| Linux | timer do `systemd --user` |
| Windows | Agendador de Tarefas (`schtasks`) |

Os três foram registrados, executados e removidos em teste automatizado.

## O que o `doctor` verifica

- Versões de Node e git.
- Se a pasta é um cérebro (`.cabecao.json`) e a versão do esquema.
- Remoto: alcançável, credencial funcionando sem terminal, visibilidade pública (só em HTTPS).
- `.gitignore` e `.gitattributes` corretos.
- Banco local em dia com o último commit.
- Runtime e modelo de embeddings; trechos sem embedding.
- Travas órfãs e operações interrompidas.
- Conflitos pendentes.
- Clientes MCP registrados e respondendo.
- `commit.gpgsign` ativo (pode travar o sync sem terminal).
- No Windows, caminho do cérebro perto do limite de 260 caracteres.

## Atualizar

- `npx cabecao@latest` sempre traz a versão nova; o plugin e o `.mcpb` trazem o servidor embutido e se atualizam pelos próprios canais.
- Quando o esquema muda, `cabecao upgrade` cria um ponto de restauração e aplica as migrações, um commit por migração.
- Versionamento semântico: mudança de esquema só em versão menor (com migração automática) ou maior.

## Onde ficam as coisas

| Item | Caminho |
|---|---|
| Cérebro | `~/cabecao`, ou onde você escolher |
| Banco e cópia local do índice | `<cérebro>/.cabecao/` |
| Configuração da máquina (nome, cérebro padrão) | `~/.config/cabecao/` · Windows: `%APPDATA%\cabecao` |
| Runtime e modelo de embeddings | `~/.cache/cabecao/` · Windows: `%LOCALAPPDATA%\cabecao` |

## Desinstalar

`cabecao uninstall` remove os registros nos clientes, a tarefa agendada e os diretórios de configuração e cache. **Nunca** apaga o cérebro.
