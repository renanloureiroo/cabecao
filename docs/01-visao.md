# 01 · Visão

## Problema

Agentes de IA **não têm memória**. Cada sessão começa do zero, e cada ferramenta (Claude Code, Claude Desktop, Codex, Cursor) tem o próprio jeito, incompatível, de "lembrar". Ao mesmo tempo, quem tenta manter um **segundo cérebro** pessoal desiste porque a manutenção cresce mais rápido que o valor.

As soluções atuais costumam obrigar a escolher um lado:

| Abordagem | Ponto forte | Ponto fraco |
|---|---|---|
| Arquivos Markdown (`CLAUDE.md`, LLM Wiki) | Legível, versionável, portátil | Busca fraca em escala; sem grafo nem embeddings |
| Frameworks de memória (Mem0, Zep, Letta) | Busca e grafo poderosos | Opacos, presos a infra/serviço, difíceis de auditar |
| RAG com banco vetorial | Escala | Não acumula conhecimento; os índices não viajam entre máquinas |

## Proposta

**Cabeção = a legibilidade do Markdown + o poder de índices, embeddings e grafo + a sincronização do git.**

Um único cérebro, com:
- **conteúdo** em Markdown, legível no Obsidian;
- **índices completos** (texto, vetores, grafo, fatos temporais);
- **sincronização de tudo**, inclusive os derivados caros, entre máquinas, via git/GitHub;
- **acesso por qualquer agente** via MCP.

## Objetivos

1. **Local-first:** funciona 100% offline, sem chave de API.
2. **Nada é jogado fora:** embeddings, grafo e extrações de LLM são persistidos e sincronizados. Nenhuma máquina recalcula o que outra já calculou.
3. **Fácil de instalar:** um comando (`npx cabecao init`) ou um clique (plugin/MCPB).
4. **Fácil de manter:** `doctor`, migrações automáticas, atualizações sem quebrar o cérebro.
5. **Auditável:** toda mudança é um commit; mudanças grandes da IA chegam como PR.
6. **Agnóstico de agente:** qualquer cliente MCP funciona.
7. **Seguro por padrão:** proveniência, níveis de confiança, scanner de segredos.

## Não-objetivos (por enquanto)

- Não é um app de notas: o editor é o Obsidian (ou qualquer editor).
- Não é um serviço hospedado multi-tenant.
- Não é para acervos com milhões de documentos: o alvo é de **centenas a dezenas de milhares** de notas.
- Não treina nem ajusta modelos.

## Personas

| Persona | Uso principal |
|---|---|
| **Dev com agentes** | Memória compartilhada entre Claude Code, Codex e Cursor; handoffs entre sessões; regras e armadilhas por projeto |
| **Estudante / pesquisador** | LLM Wiki: ingerir fontes, perguntar, revisar, visualizar no Obsidian |
| **Profissional do conhecimento** | Decisões, reuniões, pessoas e projetos ligados num grafo, consultáveis por IA |

## Princípios de design

1. **Markdown + git são a fonte da verdade.** O que não está no repositório pode ser reconstruído a partir dele.
2. **O derivado caro é persistido e o derivado barato é materializado.** Ver [ADR-0005](adr/0005-sincronizacao-de-derivados.md).
3. **A inteligência mora no agente.** O servidor guarda, busca, versiona e valida; quem raciocina é o cliente. Ver [ADR-0007](adr/0007-inteligencia-no-cliente.md).
4. **A IA propõe e o humano aprova** mudanças estruturais (consolidação via PR).
5. **Memória é dado, não instrução.**
6. **Comece simples e cresça sob demanda:** toda capacidade avançada é opcional e desligável.
