/**
 * Mescla de `.gitignore` e `.gitattributes` que já existem: só ACRESCENTA as linhas que faltam, no fim, depois de um
 * comentário `# Cabeção`. O que o usuário escreveu fica byte a byte como estava (inclusive CRLF e a falta de quebra
 * de linha no fim, que recebe a quebra antes do acréscimo).
 */
import { MERGE_HEADER } from './template.ts';

export interface LineMergeResult {
  /** Conteúdo final; igual ao de entrada quando nada faltava. */
  readonly content: string;
  /** Linhas acrescentadas, na ordem em que entraram. */
  readonly added: readonly string[];
}

/** Linhas significativas: sem espaço nas pontas, sem comentários e sem linhas vazias. */
function meaningfulLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/**
 * Forma canônica de um padrão de `.gitignore` para comparar equivalência: `.cabecao`, `/.cabecao`, `.cabecao/`,
 * `/.cabecao/`, `.cabecao/*` e `.cabecao/**` ignoram, para o Cabeção, a mesma coisa (a pasta na raiz).
 */
function ignoreKey(pattern: string): string {
  return pattern
    .replace(/^\//, '')
    .replace(/\/\*\*?$/, '/')
    .replace(/\/$/, '');
}

function appendLines(existing: string, lines: readonly string[]): string {
  if (lines.length === 0) return existing;
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  let base = existing;
  if (base !== '' && !base.endsWith('\n')) base += eol;
  // uma linha em branco separa o acréscimo do que já havia
  if (base !== '' && !base.endsWith(`${eol}${eol}`) && base !== eol) base += eol;
  return `${base}${[MERGE_HEADER, ...lines].join(eol)}${eol}`;
}

/** Acrescenta ao `.gitignore` os padrões que faltam. Um padrão negado (`!.cabecao/`) não conta como presente. */
export function mergeGitignore(existing: string, required: readonly string[]): LineMergeResult {
  const present = new Set(
    meaningfulLines(existing)
      .filter((line) => !line.startsWith('!'))
      .map(ignoreKey),
  );
  const added = required.filter((line) => !present.has(ignoreKey(line)));
  return { content: appendLines(existing, added), added };
}

/** `padrão atributo atributo...` → padrão (sem `/` inicial) e lista de atributos. */
function parseAttributeLine(line: string): { pattern: string; attributes: string[] } | null {
  const [pattern, ...attributes] = line.split(/\s+/);
  if (pattern === undefined || pattern === '' || attributes.length === 0) return null;
  return { pattern: pattern.replace(/^\//, ''), attributes };
}

/**
 * Acrescenta ao `.gitattributes` as linhas que faltam. Uma linha conta como presente quando algum padrão igual (com
 * ou sem `/` inicial) já declara TODOS os atributos dela. Como no git a última linha vence, o acréscimo no fim
 * prevalece sobre uma declaração anterior diferente (`log.md merge=binary`).
 */
export function mergeGitattributes(existing: string, required: readonly string[]): LineMergeResult {
  const declared = meaningfulLines(existing)
    .map(parseAttributeLine)
    .filter((entry) => entry !== null);
  const added = required.filter((line) => {
    const wanted = parseAttributeLine(line.trim());
    if (wanted === null) return false;
    // só a última declaração de cada atributo vale; procura de trás para frente
    return !wanted.attributes.every((attribute) => {
      const name = attribute.replace(/^[-!]/, '').split('=')[0];
      for (let i = declared.length - 1; i >= 0; i--) {
        const entry = declared[i];
        if (entry === undefined || entry.pattern !== wanted.pattern) continue;
        const match = entry.attributes.findLast((item) => item.replace(/^[-!]/, '').split('=')[0] === name);
        if (match !== undefined) return match === attribute;
      }
      return false;
    });
  });
  return { content: appendLines(existing, added), added };
}
