# 01 · Visão

## Problema

Agentes de IA não têm memória: cada sessão começa do zero, e cada ferramenta (Claude Code, Claude Desktop, Codex, Cursor) lembra de um jeito próprio e incompatível. Ao mesmo tempo, quem tenta manter um segundo cérebro pessoal desiste, porque a manutenção cresce mais rápido que o valor.

As soluções atuais obrigam a escolher:

| Abordagem | Ponto forte | Ponto fraco |
|---|---|---|
| Arquivos Markdown (`CLAUDE.md`, LLM Wiki) | Legível, versionável, portátil | Busca fraca; nada de embeddings nem grafo |
| Frameworks de memória (Mem0, Zep, Letta) | Busca e grafo poderosos | Opacos, presos a um serviço, difíceis de auditar |
| RAG com banco vetorial | Escala | Não acumula conhecimento; o índice não viaja entre máquinas |

## Proposta

**Cabeção = a legibilidade do Markdown + busca híbrida e grafo + sincronização por git.**

Um cérebro **pessoal**, usado por **uma pessoa em várias máquinas** e por todos os agentes dela.

## Objetivos

1. **Seu repositório, em qualquer lugar.** Funciona com qualquer remoto git. Não usa API de provedor, Pull Request nem CI.
2. **Instalação com uma informação só:** a URL do repositório.
3. **Nada é descartado.** Conteúdo, embeddings e grafo sincronizam; nenhuma máquina recalcula o que outra já calculou.
4. **Local-first.** Funciona offline e sem chave de API; o modelo de embeddings roda na sua máquina.
5. **Fácil de manter.** Sem daemon obrigatório, sem dependência nativa, com `doctor` e `undo`.
6. **Auditável e reversível.** Toda mudança é um commit com sessão, máquina e cliente identificados.
7. **Agnóstico de agente.** Qualquer cliente MCP funciona, das duas gerações do protocolo.
8. **Visual.** O cérebro abre como um vault do Obsidian, com grafo colorido e painéis.

## O que fica de fora

- **Uso em time.** Não há camadas pessoal/time, permissões nem fluxo de revisão. Se várias pessoas clonarem o mesmo cérebro, o sync funciona, mas o desenho não foi pensado para isso.
- **Revisão por Pull Request.** A manutenção grava direto, e a segurança vem do `undo`.
- **Serviço hospedado** e acesso remoto ao servidor.
- **Extração de entidades por LLM dentro do servidor** (GraphRAG completo). A medição mostrou que não se paga; ver [06](06-busca-e-grafo.md).
- **Acervos gigantes.** O alvo confortável é até cerca de 30 mil notas.

## Princípios de design

1. **Markdown + git são a fonte da verdade.** O índice local é sempre reconstruível.
2. **O que é caro de calcular é guardado e sincronizado.** Embeddings vão para o git; o banco de consulta é montado localmente em segundos.
3. **A inteligência mora no agente.** O servidor guarda, busca, valida e versiona. Quem raciocina é o cliente.
4. **Memória é dado, não instrução.**
5. **Só entra no plano o que foi provado.** Ver [11 · Evidências](11-evidencias.md).
6. **O núcleo é leve; o resto é opcional.** Busca por palavra-chave funciona logo após instalar. Busca semântica, agendamento e integrações são ativados à parte.
