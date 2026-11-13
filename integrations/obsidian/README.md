# Obsidian

A integração com o Obsidian não tem arquivos soltos aqui: o pacote publicado é um bundle, então o conteúdo vive no código e é gerado pelo comando, como o modelo do cérebro.

| O quê | Onde fica no código | Gerado por |
|---|---|---|
| `.obsidian/app.json`, `graph.json` e `types.json` (o que se quer) | `packages/core/src/obsidian/settings.ts` e `palette.ts` | `cabecao obsidian setup` |
| Mesclagem segura com o JSON do usuário | `packages/cli/src/obsidian/merge.ts` e `json-edit.ts` | `cabecao obsidian setup` |
| Painéis `dashboards/*.base` | `packages/core/src/obsidian/dashboards.ts` | `cabecao obsidian setup` |
| Modelo do Web Clipper | `packages/core/src/obsidian/clipper.ts` | `cabecao obsidian setup` (em `dashboards/cabecao-web-clipper.json`) e `cabecao obsidian clipper` |
| Mapa do grafo em JSON Canvas | `packages/core/src/obsidian/canvas.ts` | `cabecao export canvas` |

Regras da mesclagem: só acrescenta o que falta; nunca troca, tira nem reordena o que é do usuário; não reformata o arquivo; guarda o original em `.cabecao/backups/obsidian/` na primeira alteração; é idempotente; não toca em `workspace.json` nem em `plugins/`; `--dry-run` mostra a diferença; `--remove` tira só o que o setup acrescentou e continua com o valor que o Cabeção pôs.

Uso e exemplos: [Usar com o Obsidian](https://renanloureiroo.github.io/cabecao/guias/obsidian).

## O que foi conferido e o que não foi

- Sintaxe dos `.base`: conferida na documentação oficial do Bases (obsidian.md/help/bases/syntax e /functions) e nas duas armadilhas medidas no aplicativo pela prova de conceito (`prop == null`, `(today() - data).days`). Os painéis finais não foram abertos num Obsidian durante o desenvolvimento.
- `.canvas`: conferido contra a especificação JSON Canvas 1.0 (jsoncanvas.org/spec/1.0) por um validador e por testes de propriedade.
- `app.json`, `graph.json` e `types.json` não têm documentação oficial: as chaves são as conferidas no Obsidian 1.15 pela prova de conceito.
- Web Clipper: conferido contra o importador da extensão (`obsidianmd/obsidian-clipper`, `src/utils/import-export.ts`); não foi importado numa extensão de verdade.
- Obsidian aberto: detectado pelo `obsidian.json` do aplicativo (só leitura) e pela lista de processos.
