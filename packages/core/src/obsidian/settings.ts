// O que o `cabecao obsidian setup` quer em `.obsidian/` (doc 09, "Configurar com um comando"). Só os dados: a
// mesclagem com o que o usuário já tem é da CLI, que edita o texto do arquivo sem reformatar o resto.
//
// Os formatos de `app.json`, `graph.json` e `types.json` não têm documentação oficial: as chaves vieram de arquivos
// reais e foram conferidas no Obsidian 1.15 pelo spike 15 (itens 8b, 8g e 10). `workspace.json`, `appearance.json`,
// `core-plugins.json` e `plugins/` nunca são tocados: o primeiro é estado da interface, e os outros o aplicativo cria.
import type { RelationsConfig } from '../vault/index.ts';
import { ARCHIVE_DIR, DATE_FIELDS, relationTypes, SUPERSEDE_FIELDS } from '../vault/index.ts';
import { COLOR_GROUPS, graphQuery, rgbInt } from './palette.ts';

/** Pasta dos painéis e mapas (a mesma do modelo do cérebro). */
export const OBSIDIAN_DASHBOARDS_DIR = 'dashboards';
/** Pasta de configuração do Obsidian, relativa à raiz do vault. */
export const OBSIDIAN_DIR = '.obsidian';
/** Os três arquivos que o setup mescla, na ordem em que aparecem na saída. */
export const OBSIDIAN_SETTINGS_FILES = ['app.json', 'graph.json', 'types.json'] as const;
export type ObsidianSettingsFile = (typeof OBSIDIAN_SETTINGS_FILES)[number];

export type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike };

/** Grupo de cor no formato do `graph.json`. */
export interface GraphColorGroup {
  readonly query: string;
  readonly color: { readonly a: number; readonly rgb: number };
}

export interface ObsidianSettings {
  /** `app.json`: chaves que só entram se o usuário ainda não tem (nunca troca uma escolha dele). */
  readonly appKeys: Readonly<Record<string, JsonLike>>;
  /** `app.json`: listas que recebem os itens que faltam (união), sem tirar nem reordenar os do usuário. */
  readonly appLists: Readonly<Record<string, readonly string[]>>;
  /** `graph.json`: grupos de cor, acrescentados depois dos do usuário quando a consulta ainda não existe. */
  readonly colorGroups: readonly GraphColorGroup[];
  /** `graph.json` completo, usado só quando o arquivo ainda não existe. */
  readonly freshGraph: Readonly<Record<string, JsonLike>>;
  /** `types.json`: tipo de cada propriedade, acrescentado só quando o usuário não definiu outro. */
  readonly types: Readonly<Record<string, string>>;
}

/** Campos de texto do frontmatter (doc 03) que o Obsidian deve tratar como texto, não adivinhar. */
const TEXT_FIELDS = ['type', 'title', 'scope', 'trust', 'origin', 'edited_by', 'subject', 'predicate', 'object'];

/**
 * Configuração desejada, função pura: a mesma entrada dá sempre o mesmo resultado. As relações extras do
 * `.cabecao.json` (`relations`) também viram listas.
 */
export function obsidianSettings(config: RelationsConfig = {}): ObsidianSettings {
  const types: Record<string, string> = {};
  for (const field of TEXT_FIELDS) types[field] = 'text';
  // `published` vem do modelo do Web Clipper
  for (const field of [...DATE_FIELDS, 'published']) types[field] = 'date';
  // relações e `sources`: listas de wikilinks (ADR 27); no Obsidian, "List" é `multitext`
  for (const field of ['sources', ...SUPERSEDE_FIELDS, ...relationTypes(config)]) types[field] = 'multitext';

  return {
    appKeys: {
      newLinkFormat: 'shortest',
      useMarkdownLinks: false,
      alwaysUpdateLinks: true,
      attachmentFolderPath: 'raw/assets',
    },
    // o arquivo morto fica fora da busca, do grafo e das menções (doc 09); continua no explorador e no git
    appLists: { userIgnoreFilters: [`${ARCHIVE_DIR}/`] },
    colorGroups: COLOR_GROUPS.map((group) => ({ query: graphQuery(group), color: { a: 1, rgb: rgbInt(group.color) } })),
    freshGraph: {
      'collapse-filter': false,
      // os painéis (.base) e mapas (.canvas) apareceriam como nós soltos
      search: `-path:${OBSIDIAN_DASHBOARDS_DIR}`,
      showTags: false,
      showAttachments: false,
      hideUnresolved: false,
      showOrphans: true,
      'collapse-color-groups': false,
      colorGroups: [],
      'collapse-display': true,
      showArrow: true,
      textFadeMultiplier: 0,
      nodeSizeMultiplier: 1,
      lineSizeMultiplier: 1,
      'collapse-forces': true,
      centerStrength: 0.5,
      repelStrength: 10,
      linkStrength: 1,
      linkDistance: 250,
      scale: 1,
      close: false,
    },
    types,
  };
}
