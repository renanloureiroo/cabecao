// Modelo da extensão Obsidian Web Clipper que salva um recorte em `raw/articles/` com o frontmatter das fontes do
// Cabeção (doc 09, "Capturar da web"): o mesmo do `ingest` (`title`, `source`, `author`, `origin`, `trust: low`,
// `created`), com `origin: ingest:web-clipper`. Depois de salvar, o agente lê a fonte com `ingest` (um arquivo que já
// está em `raw/` não é copiado de novo: só sai o plano).
//
// Formato conferido no código do importador da extensão (obsidianmd/obsidian-clipper, src/utils/import-export.ts):
// `schemaVersion` "0.1.0"; obrigatórios `name`, `behavior`, `properties` e `noteContentFormat`, mais `noteNameFormat`
// e `path` fora das notas diárias; cada propriedade com `name` e `value`, e `type` entre `text`, `multitext`,
// `number`, `checkbox`, `date` e `datetime`. A importação na extensão do navegador não foi testada.
import { RAW_DIR } from '../vault/index.ts';

/** Mesma pasta do `ingest` (`INGEST_DIR`). */
const CLIP_DIR = `${RAW_DIR}/articles`;

export const CLIPPER_SCHEMA_VERSION = '0.1.0';
/** Onde o setup grava o modelo, para o usuário importar na extensão. */
export const CLIPPER_TEMPLATE_PATH = 'dashboards/cabecao-web-clipper.json';
/** Tipos de propriedade que o importador aceita. */
export const CLIPPER_PROPERTY_TYPES = ['text', 'multitext', 'number', 'checkbox', 'date', 'datetime'] as const;
/** Comportamentos de nota da extensão; o modelo usa `create`. */
export const CLIPPER_BEHAVIORS = [
  'create',
  'append-specific',
  'append-daily',
  'prepend-specific',
  'prepend-daily',
  'overwrite',
] as const;

export interface ClipperProperty {
  readonly name: string;
  readonly value: string;
  readonly type: (typeof CLIPPER_PROPERTY_TYPES)[number];
}

export interface ClipperTemplate {
  readonly schemaVersion: string;
  readonly name: string;
  readonly behavior: (typeof CLIPPER_BEHAVIORS)[number];
  readonly noteContentFormat: string;
  readonly properties: readonly ClipperProperty[];
  readonly triggers: readonly string[];
  readonly noteNameFormat: string;
  readonly path: string;
}

const DAY = '{{date|date:"YYYY-MM-DD"}}';

/** O modelo, na ordem de chaves da exportação da própria extensão. Função pura. */
export function webClipperTemplate(): ClipperTemplate {
  return {
    schemaVersion: CLIPPER_SCHEMA_VERSION,
    name: 'Cabeção: fonte em raw/articles',
    behavior: 'create',
    noteContentFormat: '{{content}}',
    properties: [
      { name: 'title', value: '{{title}}', type: 'text' },
      { name: 'source', value: '{{url}}', type: 'text' },
      { name: 'author', value: '{{author}}', type: 'text' },
      { name: 'published', value: '{{published|date:"YYYY-MM-DD"}}', type: 'date' },
      { name: 'origin', value: 'ingest:web-clipper', type: 'text' },
      { name: 'trust', value: 'low', type: 'text' },
      { name: 'created', value: DAY, type: 'date' },
    ],
    triggers: [],
    noteNameFormat: `${DAY} {{title|safe_name}}`,
    path: CLIP_DIR,
  };
}

/** O arquivo JSON do modelo (tabulação, como a extensão exporta), terminado em LF. */
export function webClipperTemplateFile(): string {
  return `${JSON.stringify(webClipperTemplate(), null, '\t')}\n`;
}

/**
 * Confere um modelo com as mesmas regras do importador da extensão e mais as do Cabeção (grava em `raw/`, com
 * `trust: low`). Devolve os problemas; lista vazia é válido.
 */
export function validateClipperTemplate(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['o modelo deveria ser um objeto'];
  const t = value as Record<string, unknown>;
  for (const key of ['name', 'behavior', 'properties', 'noteContentFormat']) {
    if (!(key in t)) problems.push(`falta "${key}"`);
  }
  if (t.schemaVersion !== CLIPPER_SCHEMA_VERSION)
    problems.push(`"schemaVersion" deveria ser "${CLIPPER_SCHEMA_VERSION}"`);
  const daily = t.behavior === 'append-daily' || t.behavior === 'prepend-daily';
  if (!daily && (!('noteNameFormat' in t) || !('path' in t))) problems.push('falta "noteNameFormat" ou "path"');
  if (!(CLIPPER_BEHAVIORS as readonly unknown[]).includes(t.behavior)) problems.push('"behavior" desconhecido');
  if (t.context !== undefined && typeof t.context !== 'string') problems.push('"context" deveria ser texto');
  if (!Array.isArray(t.properties)) {
    problems.push('"properties" deveria ser uma lista');
  } else {
    for (const property of t.properties as unknown[]) {
      const p = (property ?? {}) as Record<string, unknown>;
      if (typeof p.name !== 'string' || typeof p.value !== 'string') problems.push('propriedade sem "name" ou "value"');
      if (p.type !== undefined && !(CLIPPER_PROPERTY_TYPES as readonly unknown[]).includes(p.type)) {
        problems.push(`propriedade "${String(p.name)}" com tipo desconhecido`);
      }
    }
    const props = new Map((t.properties as Array<Record<string, unknown>>).map((p) => [p.name, p.value]));
    if (props.get('trust') !== 'low') problems.push('uma fonte de fora entra com trust: low');
  }
  if (typeof t.path === 'string' && !(t.path === 'raw' || t.path.startsWith('raw/'))) {
    problems.push('o recorte deveria ir para raw/');
  }
  return problems;
}
