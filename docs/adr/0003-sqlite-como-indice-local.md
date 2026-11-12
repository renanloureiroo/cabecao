# ADR-0003 · SQLite (FTS5 + sqlite-vec) como índice local

**Status:** Aceito, a validar no spike · **Data:** 2026-11-12

## Contexto
A busca precisa de texto completo, vetores e grafo, sem exigir que o usuário rode um servidor de banco.

## Decisão
Um único arquivo SQLite em modo WAL, com FTS5 para texto, `sqlite-vec` para vetores e tabelas comuns para o grafo. O arquivo fica em `.cabecao/cache/` e **não** entra no git.

## Consequências
- ✅ Zero infraestrutura; consultas que cruzam texto, vetor e grafo num lugar só.
- ✅ Vários processos podem ler e escrever (WAL).
- ❌ Busca vetorial por força bruta: boa até centenas de milhares de trechos, não além.
- ❌ O arquivo binário não é versionável; por isso ele é derivado e reconstruído ([ADR-0005](0005-sincronizacao-de-derivados.md)).

## Alternativas
- **LanceDB / Qdrant embutido:** melhores em escala vetorial, mas exigiriam um segundo motor para texto e grafo.
- **Postgres + pgvector:** exige servidor.
- **Banco de grafo (Kuzu, Neo4j):** poder de consulta que ainda não precisamos; pode entrar depois como índice adicional.
