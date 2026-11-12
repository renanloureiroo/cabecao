# ADR-0007 · A inteligência mora no agente

**Status:** Aceito · **Data:** 2026-11-12

## Contexto
Resumir fontes, extrair fatos, decidir o que substitui o quê e consolidar memórias exige um LLM. O servidor poderia embutir um (local ou por API), mas o MCP 2026-07-28 descontinuou o *sampling*, que seria o jeito de pegar emprestado o modelo do cliente.

## Decisão
O servidor **não chama LLM**. Ele guarda, busca, valida, versiona e prepara material. O raciocínio é feito pelo agente que já está atendendo o usuário:

- tools como `ingest` e `consolidate` devolvem o material e um plano; o agente escreve o resultado com as tools de escrita;
- tarefas agendadas que exigem raciocínio são disparadas pela CLI, que chama um agente não interativo.

## Consequências
- ✅ Sem chave de API, sem custo extra, sem modelo local pesado obrigatório.
- ✅ A qualidade da extração acompanha a do agente do usuário.
- ❌ A qualidade varia conforme o agente conectado.
- ❌ Automação em segundo plano depende de haver um agente de linha de comando instalado.
- ❌ Captura automática por hooks é limitada: hooks rodam comandos, não raciocinam.

## Alternativas
- **LLM embutido obrigatório:** automação total, mas instalação pesada ou dependência de API.
- **LLM embutido opcional (Ollama):** pode entrar depois como provedor de extração em segundo plano, sem mudar esta decisão.
