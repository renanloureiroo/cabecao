# Fixtures

## `vault/`: cérebro de exemplo

Um cérebro pequeno, em português, que segue o modelo de dados. Os testes do projeto leem daqui.

**Tudo é inventado**: a empresa Lumen Logística, o Projeto Atlas, Ana Prado e Bruno Tavares não existem. Nunca coloque dados de um cérebro real nesta pasta.

### O que ele cobre

| Recurso | Onde |
|---|---|
| Os 12 tipos de nota | `wiki/` e `memory/` |
| Fatos com validade no tempo, vencidos e vigentes | `memory/facts/` (fila do Atlas e liderança do Atlas) |
| Decisão substituída por outra | `wiki/decisions/` |
| Relações tipadas, uma propriedade por relação | `uses`, `part_of`, `depends_on`, `decided_by`, `works_on`, `related_to` |
| Wikilink simples, com apelido, com seção, embutido e por caminho | `wiki/` |
| Wikilink com caixa diferente do nome do arquivo | `[[projeto atlas]]` em `Idempotência.md` |
| Wikilink para nota que não existe | `[[Kafka]]` em `Fila de mensagens.md` (o único) |
| `[[...]]` dentro de código, que não é link | `Fila de mensagens.md` |
| Nome de arquivo com acento e espaço | `Idempotência.md`, `Lumen Logística.md`, `Reunião de arquitetura 2026-05-03.md` |
| Fonte bruta sem frontmatter | `raw/meetings/2026-05-03-arquitetura.md` |
| Fonte bruta com frontmatter de fora, sem `id` | `raw/articles/filas-gerenciadas-vs-autogeridas.md` |
| Memória arquivada | `memory/_archive/` |
| Handoff com `expires_at` | `memory/handoffs/` |

O teste `packages/core/test/fixture-vault.test.ts` confere essas propriedades. Se você mudar o vault, mude o teste junto.

O vault não tem a pasta `.cabecao/` nem a branch de índice: as duas são criadas pelo Cabeção em uso.

## `eval/respostas.jsonl`: perguntas para `cabecao eval --answers`

Oito perguntas sobre o cérebro de exemplo para medir as respostas do `ask`: seis com a nota que responde em `expected` e duas que o cérebro não responde (`"answerable": false`). Rodar com um provedor de verdade custa uma chamada por pergunta.
