# 02 · Arquitetura

> **Estado (marco 1):** existem o servidor MCP stdio, a CLI (8 comandos), o vault, o indexador incremental, a busca por palavra-chave, o sync por git da branch principal e o scanner de segredos. A busca híbrida com embeddings, a branch `cabecao/index` e o runtime de embeddings são do marco 2; o grafo e os fatos temporais como recurso de uso, do marco 3; o plugin, o `cabecao serve` e os demais comandos, dos marcos 4 a 6. O diagrama mostra o desenho completo.

## Componentes

```mermaid
flowchart TB
    subgraph Clientes
      CC[Claude Code<br/>plugin: MCP + hooks + skill]
      CD[Claude Desktop<br/>pacote .mcpb]
      OT[Codex · Cursor · outros]
      OB[Obsidian]
    end

    subgraph Cabecao["cabecao (bundle JS, sem dependências de runtime)"]
      MCP[Servidor MCP stdio<br/>duas gerações do protocolo]
      CLI[CLI: init · sync · doctor · undo · ...]
      subgraph Core
        VA[Vault: parser próprio,<br/>escrita atômica]
        IX[Indexador incremental]
        SE[Busca híbrida]
        GR[Grafo e fatos temporais]
        SY[Sync por git]
        SEC[Scanner de segredos]
      end
      EM[Runtime de embeddings<br/>opcional, baixado sob demanda]
    end

    subgraph Dados
      MAIN[(Branch principal<br/>notas em Markdown)]
      IDX[(Branch cabecao/index<br/>embeddings + grafo)]
      DB[(Índice local<br/>SQLite + vetores em memória)]
      REM[(Qualquer remoto git)]
    end

    CC --> MCP
    CD --> MCP
    OT --> MCP
    MCP --> Core
    CLI --> Core
    Core --> EM
    VA <--> MAIN
    SY <--> MAIN
    SY <--> IDX
    IX --> DB
    SE --> DB
    MAIN <--> REM
    IDX <--> REM
    OB <--> MAIN
```

## Processos: sem daemon

Não existe serviço rodando o tempo todo. Cada processo é autossuficiente:

| Processo | Quem inicia | O que faz |
|---|---|---|
| `cabecao mcp` | O cliente MCP, um por cliente aberto | Atende as tools. Ao subir, **não faz nada com efeito colateral**; a varredura incremental roda na primeira chamada |
| `cabecao sync` | Você ou a tool `sync` (marco 1); hook de fim de sessão e agendador do sistema (marco 4) | Sincroniza e sai. Roda como processo filho, separado do servidor |
| `cabecao serve` (marco 6) | Você, opcionalmente | Expõe o mesmo servidor por HTTP em `127.0.0.1`, com token |

Vários processos convivem na mesma máquina: o SQLite em modo WAL aceita escritores simultâneos, e um arquivo de trava serializa as operações de git. Testado com 8 processos, 880 escritas e 36 syncs, sem corrupção.

Arquivos alterados fora do Cabeção (você editando no Obsidian) são detectados por uma **varredura incremental** de data e tamanho, que leva menos de 1 segundo em 30 mil notas. O aviso de alteração do sistema operacional serve só de gatilho para essa varredura, porque sozinho ele perde eventos no Windows.

## Escolhas técnicas

Todas vêm de medição; os números estão em [11 · Evidências](11-evidencias.md).

| Camada | Escolha | Alternativa descartada |
|---|---|---|
| Linguagem | TypeScript estrito | — |
| Runtime | Node.js `^22.16 \|\| >=24` | Versões anteriores não têm busca por texto no SQLite embutido |
| Banco local | `node:sqlite` embutido, com FTS5 | `better-sqlite3` fica como plano B, por ser dependência nativa |
| Busca vetorial | Força bruta em JavaScript sobre `Int8Array` | `sqlite-vec`: mesma velocidade, sem binário para Windows ARM |
| Embeddings | Modelo ONNX escolhido pelo usuário, com `onnxruntime-node`; sugestões testadas na documentação | Um modelo fixo; `transformers.js`, que pesa 470 MB |
| Parser de Markdown | Próprio (varredura de linhas + `yaml`) | `remark`: 12 vezes mais lento e errou mais casos |
| Grafo | Tabelas no SQLite + consultas recursivas | Banco de grafos, PageRank, detecção de comunidades |
| MCP | SDK oficial v2 (`@modelcontextprotocol/server` 2.4) + Zod 4 | SDK v1: clientes novos falham contra ele |
| Git | CLI `git` ≥ 2.38 do usuário | `gh` e APIs de provedor |
| Empacotamento | Um bundle gerado por `tsdown`, sem dependências de runtime. 241 kB compactado, cerca de 840 kB instalado, 18 arquivos; cada comando é carregado só quando roda (`cabecao --version` leva cerca de 26 ms) | Dependências normais: `npx` até 2 vezes mais lento |
| Projeto | pnpm, Vitest, Biome, Changesets | — |

## Estrutura do repositório do projeto

```
cabecao/
├── packages/
│   ├── core/            # markdown, security, git, util, vault, db, sync, init, brain
│   ├── server/          # servidor MCP (stdio)
│   ├── cli/             # comando `cabecao` (publicado no npm)
│   └── embeddings/      # runtime opcional (marco 2); hoje só o esqueleto do pacote
├── integrations/
│   ├── claude-code/     # plugin com o servidor embutido, hooks e skill (marco 4)
│   ├── mcpb/            # manifesto para o Claude Desktop (marco 5)
│   └── obsidian/        # grafo, painéis, tipos de propriedade, Web Clipper (marco 5)
├── scripts/             # smoke.mjs e e2e.mjs (`pnpm smoke`, `pnpm e2e`)
├── templates/vault/     # estrutura inicial do cérebro (os mesmos bytes que o `init` gera)
├── fixtures/vault/      # cérebro de exemplo, com dados inventados, usado nos testes
├── spikes/              # relatórios das provas de conceito
└── docs/
```

## Fluxos principais

### Escrita (`remember`, `write_page`)
1. Valida o esquema da nota e confere as restrições a agentes (regras, arquivos de controle, `raw/`, proveniência; ver [05](05-mcp.md#restrições-a-agentes)).
2. Passa o conteúdo pelo scanner de segredos; se achar, recusa.
3. Procura memórias parecidas e decide: criar, atualizar, substituir ou ignorar. Em caso ambíguo, devolve os candidatos para o agente decidir. (Marco 4: no marco 1 o `remember` só cria.)
4. Grava o arquivo de forma atômica (arquivo temporário + renomear).
5. Atualiza o índice local e faz um commit local no [padrão do projeto](12-commits.md).

### Busca (`search`, `recall`)
Ver [06 · Busca e grafo](06-busca-e-grafo.md).

### Sincronização
Ver [04 · Sincronização](04-sincronizacao.md).

### Onde o agente recebe as regras
A medição mostrou que só expor as tools não basta: sem instrução, o agente consultou o cérebro em 1 de 5 sessões. Com as regras no hook de início de sessão ou nas instruções do servidor, em 5 de 5. Por isso as regras de uso vão nos dois lugares; ver [05](05-mcp.md) e [07](07-ciclo-de-vida-e-seguranca.md).
