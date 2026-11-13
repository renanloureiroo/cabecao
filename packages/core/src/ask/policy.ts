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

function textList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) return null;
  return (value as string[]).map((item) => item.trim());
}

/** Lê `llm_policy` do `.cabecao.json` já carregado. Nunca lança: um campo inválido vira `allow: "none"` com o motivo. */
export function readLlmPolicy(config: Pick<BrainConfig, 'unknown'>): LlmPolicy {
  const raw = config.unknown[LLM_POLICY_KEY];
  if (raw === undefined) return OPEN;
  const closed = (problem: string): LlmPolicy => ({ ...OPEN, allow: 'none', problem });
  if (!isRecord(raw)) return closed(`"${LLM_POLICY_KEY}" deveria ser um objeto`);
  const allow = raw.allow ?? 'any';
  if (typeof allow !== 'string' || !(LLM_POLICY_ALLOW as readonly string[]).includes(allow)) {
    return closed(`"${LLM_POLICY_KEY}.allow" deveria ser um de ${LLM_POLICY_ALLOW.join(', ')}`);
  }
  const excludePaths = textList(raw.exclude_paths);
  const excludeTypes = textList(raw.exclude_types);
  const excludeTrust = textList(raw.exclude_trust);
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

/** A nota tem `private: true` (ou `"true"`, `yes`) no frontmatter. */
export function isPrivateNote(frontmatter: Readonly<Record<string, unknown>>): boolean {
  const value = frontmatter[PRIVATE_FIELD];
  if (value === true) return true;
  return typeof value === 'string' && ['true', 'yes', 'sim'].includes(value.trim().toLowerCase());
}

/** Arquivo de controle do cérebro: nunca é enviado, mesmo que a busca o devolva (vault adotado com `noteDirs: ["."]`). */
export function isControlPath(path: string, config: Pick<BrainConfig, 'indexMd'>): boolean {
  return isBrainControlFile(path, config) || isClientInstructionFile(path) || isConflictCopyPath(path);
}

export type ExclusionReason = 'private' | 'policy' | 'secret' | 'control';

/** Por que esta nota não pode sair (antes de olhar o texto), ou `null`. */
export function noteExclusion(
  note: { readonly path: string; readonly type: string | null; readonly trust: string | null },
  frontmatter: Readonly<Record<string, unknown>>,
  policy: LlmPolicy,
  config: Pick<BrainConfig, 'indexMd'>,
): ExclusionReason | null {
  if (isControlPath(note.path, config)) return 'control';
  if (isPrivateNote(frontmatter)) return 'private';
  if (note.type !== null && policy.excludeTypes.includes(note.type)) return 'policy';
  if (note.trust !== null && policy.excludeTrust.includes(note.trust)) return 'policy';
  if (policy.excludePaths.some((glob) => globToRegExp(glob).test(note.path))) return 'policy';
  return null;
}
