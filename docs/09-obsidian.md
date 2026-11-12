# 09 · Guia do Obsidian

O Obsidian é a **janela** para o seu cérebro: você lê, navega, corrige e visualiza o que a IA escreveu. Ele não é obrigatório, porque o cérebro é só Markdown, mas é a melhor experiência.

## 1. Abrir o cérebro
1. Instale o Obsidian (obsidian.md).
2. **Open folder as vault** → escolha a pasta do cérebro (ex.: `~/cabecao`).
3. Pronto. A pasta `.cabecao/` (derivados) é **oculta** e o Obsidian a ignora automaticamente.

> Rode `cabecao obsidian setup` para aplicar a configuração recomendada abaixo. Ele **mostra o diff antes** de mexer em `.obsidian/` e nunca sobrescreve suas configurações sem perguntar.

## 2. Configurações recomendadas
| Onde | Ajuste |
|---|---|
| Files & Links | *Use [[Wikilinks]]*: on · *Automatically update internal links*: on · anexos em `raw/assets` |
| Files & Links → *Excluded files* | `.cabecao`, `memory/_archive` |
| Core plugins | Graph view, Backlinks, Outgoing links, Properties, **Bases**, Canvas, Templates, Search |
| Community plugins (opcionais) | Dataview (consultas avançadas), Obsidian Git (**sem** auto pull/push se o daemon do Cabeção estiver ativo; ver [04](04-sincronizacao.md)) |
| Navegador | Extensão **Obsidian Web Clipper** com template apontando para `raw/articles/` |

## 3. Visualizando o grafo

### Graph view global
- Abra com `Ctrl/Cmd + G`.
- **Filtros** (campo *Search files*): `-path:raw -path:memory/episodes` para ver só o conhecimento compilado.
- **Grupos de cor** (o `setup` já cria):

| Grupo | Consulta | Cor |
|---|---|---|
| Concepts | `path:wiki/concepts` | azul |
| Entidades | `path:wiki/entities` | verde |
| Decisões | `path:wiki/decisions` | laranja |
| Fontes | `path:wiki/sources` | cinza |
| Regras | `path:memory/rules` | vermelho |
| Fatos | `path:memory/facts` | roxo |
| Comunidades | `path:wiki/_communities` | amarelo |

- **Forças:** aumente *Repel force* em grafos grandes; ligue *Arrows* para ver a direção das relações.
- Hubs (nós grandes) são os temas centrais. Nós soltos são **órfãos** (o `lint` também os lista).

### Graph view local
Em qualquer nota: menu `⋯` → **Open local graph**. Com profundidade 2, você vê o "bairro" daquela ideia. É o melhor jeito de entender o contexto de uma decisão.

### Relações tipadas
O grafo nativo do Obsidian mostra **links**, mas não o **tipo** da relação. Para ver os tipos:
- painel **Properties** da nota (campo `relations`);
- dashboards em **Bases** (abaixo);
- o **MCP App do grafo** dentro do Claude, que mostra cores por tipo de aresta e filtro por data (`as_of`);
- `.cabecao/graph/*.jsonl`, que pode ser importado no Gephi ou Cosmograph para análises pesadas.

## 4. Dashboards com Bases

O `setup` cria arquivos `.base` em `dashboards/`. Exemplo (`dashboards/memorias.base`):

```yaml
filters:
  and:
    - file.inFolder("memory")
    - 'superseded_by == null'
views:
  - type: table
    name: Memórias ativas
    order: [file.name, type, scope, trust, confirmed, updated]
    sort:
      - property: updated
        direction: DESC
  - type: table
    name: Precisam de revisão
    filters:
      or:
        - 'trust == "low"'
        - 'confirmed < today() - "180d"'
```

Dashboards incluídos:
| Arquivo | Mostra |
|---|---|
| `memorias.base` | memórias ativas por tipo e escopo; precisam de revisão |
| `decisoes.base` | decisões com data, status e o que substituíram |
| `fatos.base` | fatos válidos hoje, fatos expirados e linha do tempo |
| `fontes.base` | fontes ingeridas, data e quantas páginas geraram |
| `saude.base` | órfãs, conflitos e notas sem fonte |

> A sintaxe de Bases evolui com o Obsidian; o `setup` gera os arquivos compatíveis com a versão detectada.

## 5. Canvas: mapas gerados
- `cabecao export canvas --community <id>` gera um `.canvas` com as notas de uma comunidade organizadas espacialmente.
- `cabecao export canvas --around "[[Projeto Atlas]]" --depth 2` gera um mapa centrado numa nota.
- Os mapas são editáveis: arraste, agrupe e anote. Eles ficam em `dashboards/`.

## 6. Fluxos do dia a dia no Obsidian
| Quero... | Faço |
|---|---|
| Guardar um artigo | Web Clipper → `raw/articles/` → no agente: "ingerir esse artigo" |
| Ver o que a IA aprendeu esta semana | `log.md` ou `dashboards/memorias.base` ordenado por `updated` |
| Corrigir uma memória errada | Editar a nota direto no Obsidian (o daemon reindexa sozinho) |
| Revisar uma consolidação | Abrir o PR no GitHub **ou** a branch no Obsidian (`git switch`) |
| Achar algo | `Ctrl/Cmd + Shift + F` (busca do Obsidian) ou perguntar ao agente (`search` híbrido) |
| Resolver conflito de sync | Abrir as notas marcadas `conflict: true` em `saude.base` |

## 7. Celular
O Obsidian mobile abre o mesmo repositório, sincronizado por um cliente git (ex.: o plugin Obsidian Git no modo mobile). Recomendação: **apenas leitura e notas rápidas em `raw/`**; a indexação acontece quando o desktop sincroniza.
