# 08 · Instalação e operação

> 🚧 **Estado (marco 1):** a CLI tem 8 comandos implementados (`init`, `status`, `doctor`, `sync`, `search`, `undo`, `mcp`, `install-client`), na branch `feat/m1-nucleo`. **O pacote ainda não foi publicado no npm**, então `npx cabecao` só funciona depois da publicação; até lá, rode o bundle gerado por `pnpm build` (ver [13](13-publicacao.md)). O que não tem marco indicado abaixo é plano de marcos futuros, e o que está marcado como "testado" foi validado em prova de conceito.

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
2. Reconhece o que há no repositório e age conforme a tabela de [04 · Sincronização](04-sincronizacao.md): cria, baixa ou adota. Recusa um repositório de código.
3. Monta o índice local.
4. Registra o servidor MCP nos clientes encontrados.
5. Roda o `doctor` e mostra o resultado.

Sem URL, `npx cabecao init` cria um cérebro só local. O comando `cabecao remote` **não existe ainda**; para ligar um remoto depois, use o git:

```bash
git remote add origin <url>
git push -u origin <branch>
cabecao sync
```

Os cinco passos acima existem no marco 1. O passo 4 pode ser pulado com `--no-clients` e refeito depois com `cabecao install-client --all`. A branch de índice e os embeddings (passos de índice remoto e baixa de vetores) são do marco 2.

O pacote compactado tem 241 kB (cerca de 840 kB instalado, 18 arquivos) e nenhuma dependência de runtime. Mais da metade é o SDK do MCP com o Zod, carregado só no `cabecao mcp`. `cabecao --version` leva cerca de 26 ms. O primeiro `npx` foi medido na prova de conceito com um pacote bem menor (perto de 1 s no Linux e no macOS, de 6 a 11 s no Windows); não foi remedido com o pacote atual.

### Ativar a busca por significado · marco 2

O comando `cabecao embeddings` ainda não existe. O que segue é o plano.

```bash
cabecao embeddings on [modelo]
```

É um passo separado e opcional; o `init` continua pedindo só a URL. Sem o nome do modelo, o comando mostra as sugestões testadas, com tamanho, qualidade e licença de cada uma, e pergunta qual você quer. A lista está em [06 · Busca e grafo](06-busca-e-grafo.md#escolha-do-modelo).

Depois ele baixa o runtime (cerca de 115 MB) e o modelo escolhido (de 118 a 570 MB) para o diretório de cache do usuário e calcula os embeddings do que ainda não tem. A escolha fica gravada no cérebro: numa segunda máquina, `cabecao embeddings on` usa o mesmo modelo sem perguntar, e os embeddings já vêm do repositório. Antes disso tudo, a busca por palavra-chave já funciona.

### Segunda máquina

O mesmo comando, com a mesma URL:

```bash
npx cabecao init git@gitlab.com:voce/meu-cerebro.git
```

## Clientes

### Claude Code: plugin · marco 4
```text
/plugin marketplace add renanloureiroo/cabecao
/plugin install cabecao@cabecao
```
O plugin traz o servidor MCP embutido, o hook de início (briefing), o hook de fim (sync) e uma skill de referência. A pasta do cérebro é perguntada na instalação.

Testado com marketplace local; a instalação a partir do repositório público ainda não.

### Claude Code: sem plugin
`cabecao install-client claude-code` registra só o servidor MCP (existe no marco 1). Sem os hooks, as regras de uso chegam pelas instruções do servidor.

### Claude Desktop · pacote `.mcpb`: marco 5
Hoje, `cabecao install-client claude-desktop` grava a configuração do servidor. O pacote abaixo é plano:

Baixe `cabecao.mcpb` na página de versões do projeto e abra com dois cliques. Uma tela pede a pasta do cérebro. O pacote foi gerado e validado (242 KB); a instalação no aplicativo ainda não foi testada.

### Outros
O `install-client` já atende os seis clientes no marco 1, mas nenhum foi testado contra o servidor de verdade.

```bash
cabecao install-client codex
cabecao install-client cursor
cabecao install-client vscode
cabecao install-client gemini
cabecao install-client --print     # só mostra a configuração
```

## Comandos

A coluna "Marco" diz quando o comando chega. **1** = existe hoje.

| Comando | Marco | O que faz |
|---|---|---|
| `cabecao init [url]` | 1 | Instala ou conecta uma máquina |
| `cabecao status` | 1 | Notas, último sync, conflitos (a fila de embeddings é do marco 2) |
| `cabecao doctor` | 1 | Diagnóstico com a correção sugerida para cada problema |
| `cabecao sync` | 1 | Sincroniza tudo o que o git não ignora |
| `cabecao search "<pergunta>"` | 1 | Busca pelo terminal, por palavra-chave |
| `cabecao undo [--session\|--op]` | 1 | Desfaz. Aceita o começo do ULID, com pelo menos 8 caracteres |
| `cabecao mcp` | 1 | Servidor MCP (usado pelos clientes) |
| `cabecao install-client <cliente>` | 1 | Registra o servidor nos clientes de IA |
| `cabecao ingest <arquivo>` | 4 | Registra uma fonte em `raw/` |
| `cabecao lint` | 4 | Relatório de saúde |
| `cabecao consolidate` | 4 | Chama um agente não interativo para consolidar |
| `cabecao schedule on\|off` | 4 | Sync periódico pelo agendador do sistema |
| `cabecao embeddings on [modelo]\|off\|status\|switch <modelo>` | 2 | Busca por significado, com o modelo que você escolher |
| `cabecao compact` | 2 | Reduz o índice e inicia uma geração nova |
| `cabecao reindex [--full]` | 2 | Reconstrói o banco local |
| `cabecao eval` | 2 | Mede a busca com as suas perguntas |
| `cabecao obsidian setup` | 5 | Configura o vault para visualização |
| `cabecao upgrade` | 5 | Aplica migrações do esquema |
| `cabecao remote <url>` | a definir | Liga ou troca o remoto. Hoje use `git remote add origin <url>` |
| `cabecao purge <id>` | a definir | Apaga definitivamente |
| `cabecao serve` | 6 | Servidor MCP por HTTP local |
| `cabecao uninstall` | a definir | Remove registros, tarefa agendada e diretórios de configuração e cache |

## Sync automático · marco 4

No marco 1 o sync roda quando você ou o agente pedem (`cabecao sync`, tool `sync`); o hook do plugin e o agendador são do marco 4. Não há daemon. O sync acontece:

- no fim de cada sessão do Claude Code, pelo hook do plugin;
- periodicamente, se você rodar `cabecao schedule on`, que registra uma tarefa no agendador do seu sistema, sem permissão de administrador:

| Sistema | Mecanismo |
|---|---|
| macOS | LaunchAgent |
| Linux | timer do `systemd --user` |
| Windows | Agendador de Tarefas (`schtasks`) |

Os três foram registrados, executados e removidos em teste automatizado (prova de conceito).

## O que o `doctor` verifica

Marco 1 (implementado):
- Versões de Node e git, e a identidade do git.
- Se a pasta é um cérebro (`.cabecao.json`) e a versão do esquema.
- Remoto: alcançável, credencial funcionando sem terminal, visibilidade pública (só em HTTPS).
- `.gitignore` e `.gitattributes` corretos.
- Banco local em dia com o último commit.
- Travas órfãs e operações interrompidas.
- Conflitos pendentes (cópias `*.conflict-*`).
- Clientes MCP registrados.
- `commit.gpgsign` ativo: os commits do Cabeção saem sem assinatura, e o `doctor` avisa.
- No Windows, caminho do cérebro perto do limite de 260 caracteres.

Marco 2 (ainda não verificado): runtime e modelo de embeddings, trechos sem embedding.

## Atualizar · marcos 2 e 5

No marco 1 não há `upgrade`, e o pacote ainda não está no npm. O texto abaixo é o plano.

- `npx cabecao@latest` sempre traz a versão nova; o plugin e o `.mcpb` trazem o servidor embutido e se atualizam pelos próprios canais.
- Quando o esquema muda, `cabecao upgrade` cria um ponto de restauração e aplica as migrações, um commit por migração.
- Versionamento semântico: mudança de esquema só em versão menor (com migração automática) ou maior.

## Onde ficam as coisas

| Item | Caminho |
|---|---|
| Cérebro | `~/cabecao`, ou onde você escolher (`--dir`) |
| Banco e cópia local do índice | `<cérebro>/.cabecao/` |
| Configuração da máquina (nome, cérebro padrão) | `~/.config/cabecao/` · Windows: `%APPDATA%\cabecao` |
| Runtime e modelo de embeddings | `~/.cache/cabecao/` · Windows: `%LOCALAPPDATA%\cabecao` |

## Desinstalar · a definir

O comando `cabecao uninstall` ainda não existe. Plano: ele remove os registros nos clientes, a tarefa agendada e os diretórios de configuração e cache. **Nunca** apaga o cérebro.
