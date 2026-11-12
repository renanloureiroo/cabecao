# 09 · Guia do Obsidian

O Obsidian é a janela para o seu cérebro: você lê, navega, corrige e visualiza o que os agentes escreveram. Ele é opcional, porque o cérebro é só Markdown.

Os itens deste guia foram testados no Obsidian 1.15, numa instância separada. O que não foi validado está indicado.

## 1. Abrir o cérebro

1. Instale o Obsidian.
2. **Open folder as vault** → escolha a pasta do cérebro (por padrão, `~/cabecao`).

A pasta `.cabecao/`, onde ficam o banco e o índice local, é invisível no Obsidian: não aparece no explorador, na busca, nos backlinks nem no grafo.

## 2. Configurar com um comando

```bash
cabecao obsidian setup
```

**Feche o vault no Obsidian antes.** Com o aplicativo aberto, ele ignora e sobrescreve mudanças feitas nos arquivos de configuração.

O comando:

- cria ou **mescla** `app.json`, `graph.json` e `types.json` em `.obsidian/`;
- num vault que já tem configuração, não sobrescreve nada seu: mostra a diferença, faz backup e só acrescenta;
- aceita `--dry-run` para você ver antes;
- copia os painéis para `dashboards/`.

| Arquivo | O que recebe |
|---|---|
| `app.json` | Wikilinks ligados, atualização automática de links, anexos em `raw/assets`, `memory/_archive` fora da busca |
| `graph.json` | Grupos de cor por tipo de nota |
| `types.json` | Relações (`uses`, `part_of`...) registradas como listas; datas como datas |

## 3. O grafo

Abra com `Ctrl/Cmd + G`.

### Cores
A ordem importa: a primeira regra que casa define a cor, então as específicas vêm antes.

| Grupo | Consulta |
|---|---|
| Regras | `path:memory/rules` |
| Fatos | `path:memory/facts` |
| Decisões | `path:wiki/decisions` |
| Conceitos | `path:wiki/concepts` |
| Entidades | `path:wiki/entities` |
| Fontes | `path:wiki/sources` |
| Episódios e handoffs | `path:memory/episodes OR path:memory/handoffs` |

Também dá para colorir por propriedade (`[type:decision]`) ou por tag.

### Filtros úteis
- `-path:raw -path:memory/episodes` mostra só o conhecimento consolidado.

### Relações tipadas no grafo
As relações do frontmatter (`uses: ["[[SQS]]"]`) viram arestas no grafo e backlinks, como qualquer link. O grafo do Obsidian não mostra o **tipo** da aresta; para ver os tipos, use o painel de propriedades da nota, os painéis abaixo ou peça ao agente (`graph`).

### Grafo local
Em qualquer nota: menu `⋯` → **Open local graph**, com profundidade 2. É a melhor forma de ver o contexto de uma decisão.

## 4. Painéis (Bases)

Cinco arquivos `.base` em `dashboards/`, todos executados no aplicativo durante o teste:

| Painel | Mostra |
|---|---|
| `memorias.base` | Memórias ativas por tipo e escopo |
| `revisar.base` | Confiança baixa ou sem confirmação há mais de 180 dias |
| `decisoes.base` | Decisões, com o que cada uma substituiu |
| `fatos.base` | Fatos vigentes e fatos vencidos |
| `saude.base` | Conflitos de sync pendentes e notas sem fonte |

Exemplo (`revisar.base`):

```yaml
filters:
  and:
    - file.inFolder("memory")
    - 'valid_until == null'
    - or:
        - 'trust == "low"'
        - 'confirmed == null'
        - 'confirmed < today() - "180d"'
formulas:
  motivo: 'if(trust == "low", "confiança baixa", if(confirmed == null, "nunca confirmada", "confirmação antiga"))'
views:
  - type: table
    name: Precisam de revisão
    order:
      - file.name
      - note.type
      - note.scope
      - note.confirmed
      - formula.motivo
    groupBy:
      property: formula.motivo
      direction: ASC
```

A sintaxe segue a dos painéis executados no teste, que usavam outros nomes de propriedade. Os painéis finais serão validados de novo com o esquema deste plano.

Duas armadilhas de sintaxe encontradas no teste:

- Para "propriedade ausente", use `prop == null`. `!prop` não funciona.
- Para diferença de datas, use `(today() - data).days`. Dividir uma duração por outra dá erro.

## 5. Mapas (Canvas)

```bash
cabecao export canvas --around "[[Projeto Atlas]]" --depth 2
```

Gera um arquivo `.canvas` em `dashboards/`, com as notas dispostas e as arestas rotuladas pelo tipo de relação. É editável: arraste, agrupe, anote. Um mapa gerado por script, com 27 nós e 10 arestas, abriu corretamente no aplicativo.

## 6. Capturar da web

A extensão **Obsidian Web Clipper** salva páginas como Markdown. O `setup` gera um modelo que grava em `raw/articles/` com o frontmatter certo (`type: source`, `trust: low`, URL e data). Importe o modelo nas configurações da extensão.

O modelo foi conferido contra o código da extensão, mas não foi importado nela.

Depois de salvar, peça ao agente: "ingira o artigo que acabei de salvar".

## 7. Dia a dia

| Quero... | Faço |
|---|---|
| Ver o que os agentes aprenderam | `memorias.base`, ordenado por atualização; ou `log.md` |
| Corrigir uma memória errada | Edito a nota. O próximo sync indexa e registra como edição manual |
| Resolver um conflito de sync | Abro `saude.base`, comparo `nota.md` com `nota.conflict-...md`, fico com o certo e apago o outro |
| Achar algo | Busca do Obsidian, ou pergunto ao agente |
| Editar relações | Painel de propriedades: cada relação é uma lista de links |

## 8. Plugin Obsidian Git

Não é necessário: o Cabeção sincroniza sozinho. Se você já usa o plugin:

- Ele pode continuar fazendo commit e pull na branch principal; o Cabeção reindexa a diferença.
- Desligue o **push e pull automáticos** dele, para não haver dois sincronizadores disputando.
- Ele não cuida da branch de índice; só o `cabecao sync` envia embeddings.

Esta convivência foi simulada com comandos git; o plugin em si não foi executado.

## 9. Celular

O Obsidian no celular abre o mesmo repositório por um cliente git. Use para ler e para anotações rápidas em `raw/`. Indexação e embeddings acontecem quando um computador sincronizar. Não testado.
