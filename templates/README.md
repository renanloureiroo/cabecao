# Modelos

## `vault/`

Estrutura inicial de um cérebro, a mesma que o `cabecao init` cria quando o repositório remoto está vazio (ou quando não há remoto). A estrutura está descrita em 03 · Modelo de dados.

| Arquivo | Para quê |
|---|---|
| `.cabecao.json` | Marca a pasta como cérebro; configuração compartilhada entre as máquinas |
| `.gitignore` | Ignora `.cabecao/` (banco e índice locais), os temporários da escrita atômica e o estado das janelas do Obsidian |
| `.gitattributes` | `log.md` com merge por união |
| `AGENTS.md` | Regras de uso do cérebro para qualquer agente |
| `CLAUDE.md` | Importa o `AGENTS.md` para o Claude Code |
| `index.md` | Catálogo gerado, ainda vazio |
| `log.md` | Diário append-only, só com o título |
| `raw/`, `wiki/`, `memory/`, `dashboards/` | Pastas vazias, mantidas no git com `.gitkeep` |

**A fonte é o código, não esta pasta.** O pacote publicado é um bundle sem arquivos soltos, então o modelo vive em `brainTemplateFiles()` (`packages/core/src/init/template.ts`). Esta pasta guarda os mesmos bytes, para quem quiser ver o resultado sem rodar nada, e o teste `packages/core/test/init/template.test.ts` falha se as duas divergirem. Para mudar o modelo, mude o código e regenere a pasta:

```bash
CABECAO_WRITE_TEMPLATES=1 pnpm exec vitest run packages/core/test/init/template.test.ts
```

Ao adotar um vault que já existe, o `init` não usa o modelo inteiro: acrescenta só `.cabecao.json`, completa `.gitignore` e `.gitattributes` com as linhas que faltam e cria `AGENTS.md` e `CLAUDE.md` se não existirem. Nenhum arquivo é movido.

Para um cérebro já preenchido, usado nos testes, veja [`fixtures/vault/`](../fixtures/vault/).
