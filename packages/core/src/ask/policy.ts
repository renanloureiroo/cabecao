// O que pode sair da máquina rumo a um provedor de geração. Duas camadas:
//
// - Política do cérebro (`llm_policy` no `.cabecao.json`, sincronizado: vale em todas as máquinas). Sem o campo, o
//   cérebro não restringe nada além do que a máquina configurou (`allow: "any"`). Um campo inválido FECHA: o `ask` não
//   envia nada e diz por quê (um erro de digitação não pode abrir a porta).
// - Regras fixas, que nenhuma configuração desliga: nota com `private: true` no frontmatter, arquivos de controle
//   (catálogo, diário, arquivos de instrução de cliente de IA, cópias de conflito) e trecho em que o scanner de
//   segredos acusa algo (sem respeitar o marcador `cabecao:allow-secret`: liberar uma linha para o git não é liberar
//   para um provedor de fora).

import { isConflictCopyPath } from '../sync/conflict-name.ts';
import type { BrainConfig } from '../vault/config.ts';
import { isBrainControlFile, isClientInstructionFile } from '../vault/paths.ts';

export const LLM_POLICY_KEY = 'llm_policy';
export const LLM_POLICY_ALLOW = ['none', 'agent', 'any'] as const;
export type LlmPolicyAllow = (typeof LLM_POLICY_ALLOW)[number];

/** Campo do frontmatter que marca uma nota como privada: ela nunca é enviada a provedor nenhum. */
export const PRIVATE_FIELD = 'private';

export interface LlmPolicy {
  /** `none`: o `ask` nunca chama provedor neste cérebro; `agent`: só agente instalado; `any`: qualquer um. */
  readonly allow: LlmPolicyAllow;
  /** Globs de caminho (relativos ao cérebro, com `/`; `*`, `**` e `?`) que nunca saem. */
  readonly excludePaths: readonly string[];
  /** Tipos de nota que nunca saem. */
  readonly excludeTypes: readonly string[];
  /** Níveis de `trust` que nunca saem (por exemplo `["low"]` para não mandar conteúdo ingerido). */
  readonly excludeTrust: readonly string[];
  /** Problema no campo (a política fechou por causa dele), ou `null`. */
  readonly problem: string | null;
}

const OPEN: LlmPolicy = { allow: 'any', excludePaths: [], excludeTypes: [], excludeTrust: [], problem: null };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function textList(value: unknown, lower = false): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) return null;
  return (value as string[]).map((item) => (lower ? item.trim().toLowerCase() : item.trim()));
}

/** As subchaves que a `llm_policy` aceita: qualquer outra FECHA o envio (um erro de digitação não abre a porta). */
export const LLM_POLICY_FIELDS = ['allow', 'exclude_paths', 'exclude_types', 'exclude_trust'] as const;

/** Forma comparável de um nome de chave: sem caixa, sem separadores (`llmPolicy`, `llm-policy`, `LLM_POLICY`). */
function keyShape(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Chaves do `.cabecao.json` parecidas com `llm_policy` mas escritas de outro jeito (`llmPolicy`, `llm-policy`,
 * `llm_polcy`...). O `doctor` avisa, e sem a chave certa o envio fecha.
 */
export function llmPolicyLookalikes(config: Pick<BrainConfig, 'unknown'>): string[] {
  return Object.keys(config.unknown).filter((key) => {
    if (key === LLM_POLICY_KEY) return false;
    const shape = keyShape(key);
    return shape === 'llmpolicy' || /^llm.*pol/.test(shape) || /^(llm|ai|ask).*(policy|politica)$/.test(shape);
  });
}

/**
 * Lê `llm_policy` do `.cabecao.json` já carregado. Nunca lança: um campo inválido vira `allow: "none"` com o motivo.
 * O esquema é ESTRITO: subchave desconhecida (`exclude_path` no singular) ou uma chave parecida com `llm_policy` sem a
 * certa também fecham. Os valores de `allow` e de `exclude_trust` não diferenciam maiúsculas.
 */
export function readLlmPolicy(config: Pick<BrainConfig, 'unknown'>): LlmPolicy {
  const raw = config.unknown[LLM_POLICY_KEY];
  const closed = (problem: string): LlmPolicy => ({ ...OPEN, allow: 'none', problem });
  if (raw === undefined) {
    const lookalike = llmPolicyLookalikes(config)[0];
    return lookalike === undefined
      ? OPEN
      : closed(`a chave "${lookalike}" do .cabecao.json parece a "${LLM_POLICY_KEY}" escrita de outro jeito; renomeie`);
  }
  if (!isRecord(raw)) return closed(`"${LLM_POLICY_KEY}" deveria ser um objeto`);
  const unknownKeys = Object.keys(raw).filter((key) => !(LLM_POLICY_FIELDS as readonly string[]).includes(key));
  if (unknownKeys.length > 0) {
    return closed(
      `"${LLM_POLICY_KEY}" tem ${unknownKeys.map((key) => `"${key}"`).join(', ')}, que não existe; os campos são ${LLM_POLICY_FIELDS.join(', ')}`,
    );
  }
  const allow = typeof raw.allow === 'string' ? raw.allow.trim().toLowerCase() : (raw.allow ?? 'any');
  if (typeof allow !== 'string' || !(LLM_POLICY_ALLOW as readonly string[]).includes(allow)) {
    return closed(`"${LLM_POLICY_KEY}.allow" deveria ser um de ${LLM_POLICY_ALLOW.join(', ')}`);
  }
  const excludePaths = textList(raw.exclude_paths);
  const excludeTypes = textList(raw.exclude_types, true);
  const excludeTrust = textList(raw.exclude_trust, true);
  if (excludePaths === null || excludeTypes === null || excludeTrust === null) {
    return closed(
      `"exclude_paths", "exclude_types" e "exclude_trust" de "${LLM_POLICY_KEY}" deveriam ser listas de textos`,
    );
  }
  return { allow: allow as LlmPolicyAllow, excludePaths, excludeTypes, excludeTrust, problem: null };
}

/** Converte um glob simples em expressão regular: `**` atravessa pastas, `*` e `?` não. */
export function globToRegExp(glob: string): RegExp {
  const source = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const char = source[i] as string;
    if (char === '*') {
      if (source[i + 1] === '*') {
        // `**/` casa zero ou mais pastas; `**` no fim casa o resto
        if (source[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  // uma pasta sem curinga (`memory/private`) vale para tudo dentro dela
  const folder = !/[*?]/.test(source) && !/\.md$/i.test(source) ? '(?:/.*)?' : '';
  return new RegExp(`^${out}${folder}$`, 'i');
}

const TRUTHY = new Set(['true', 'yes', 'on', '1', 'sim', 'y', 's', 'verdadeiro', 'v']);

function truthy(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') return TRUTHY.has(value.trim().toLowerCase());
  if (Array.isArray(value)) return value.some(truthy);
  return false;
}

/** Uma tag que marca a nota como privada: `private` ou aninhada (`private/saude`), com ou sem `#`, sem caixa. */
function privateTag(tag: unknown): boolean {
  if (typeof tag !== 'string') return false;
  const clean = tag.trim().replace(/^#/, '').toLowerCase();
  return clean === PRIVATE_FIELD || clean.startsWith(`${PRIVATE_FIELD}/`);
}

/** A tag `#private` (ou `#private/...`) no corpo da nota, como o Obsidian a reconhece. */
export const BODY_PRIVATE_TAG = /(?:^|[\s(,;])#private(?:\/[^\s#]*)?(?=$|[\s.,;:!?)\]])/im;

export function hasPrivateBodyTag(body: string): boolean {
  return BODY_PRIVATE_TAG.test(body);
}

/**
 * A nota é privada (nunca vai a provedor nenhum). Na dúvida, é: a chave `private` sem diferenciar maiúsculas
 * (`Private`, `PRIVATE`), com um valor verdadeiro (`true`, `yes`, `on`, `1`, `sim`, em texto ou numa lista); a tag
 * `private` ou uma aninhada (`private/saude`), com ou sem `#`, em `tags` ou `tag`; ou, com `body`, a tag `#private` no
 * corpo (como no Obsidian). A nota com frontmatter ilegível é tratada à parte (`frontmatter_error`): também nunca sai.
 */
export function isPrivateNote(frontmatter: Readonly<Record<string, unknown>>, body?: string): boolean {
  for (const [key, value] of Object.entries(frontmatter)) {
    const name = key.trim().toLowerCase();
    if (name === PRIVATE_FIELD && truthy(value)) return true;
    if (name === 'tags' || name === 'tag') {
      const tags = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : [];
      if (tags.some(privateTag)) return true;
    }
  }
  return body !== undefined && hasPrivateBodyTag(body);
}

/** Arquivo de controle do cérebro: nunca é enviado, mesmo que a busca o devolva (vault adotado com `noteDirs: ["."]`). */
export function isControlPath(path: string, config: Pick<BrainConfig, 'indexMd'>): boolean {
  return isBrainControlFile(path, config) || isClientInstructionFile(path) || isConflictCopyPath(path);
}

export type ExclusionReason = 'private' | 'policy' | 'secret' | 'control' | 'unreadable';

/** Por que esta nota não pode sair (antes de olhar o texto), ou `null`. */
export function noteExclusion(
  note: {
    readonly path: string;
    readonly type: string | null;
    readonly trust: string | null;
    /** A nota tem a tag `#private` no corpo (lida na nota inteira). */
    readonly bodyPrivate?: boolean;
  },
  frontmatter: Readonly<Record<string, unknown>>,
  policy: LlmPolicy,
  config: Pick<BrainConfig, 'indexMd'>,
): ExclusionReason | null {
  if (isControlPath(note.path, config)) return 'control';
  if (isPrivateNote(frontmatter) || note.bodyPrivate === true) return 'private';
  if (note.type !== null && policy.excludeTypes.includes(note.type.toLowerCase())) return 'policy';
  if (note.trust !== null && policy.excludeTrust.includes(note.trust.toLowerCase())) return 'policy';
  if (policy.excludePaths.some((glob) => globToRegExp(glob).test(note.path))) return 'policy';
  return null;
}
