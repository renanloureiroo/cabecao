/** Limite de nome de arquivo no Linux, em BYTES de UTF-8 (medido no spike 14). macOS e Windows contam caracteres. */
export const MAX_FILE_NAME_BYTES = 255;

/** Troca `\` por `/`. Caminhos relativos ao cérebro são sempre guardados com `/`, em qualquer sistema. */
export function toPosixPath(path: string): string {
  return path.replaceAll('\\', '/');
}

/**
 * Normaliza para NFC. Linux e Windows tratam NFC e NFD como nomes diferentes; o macOS, como o mesmo. Normalizar
 * antes de comparar ou gravar evita o mesmo título virar dois arquivos em máquinas diferentes.
 */
export function normalizeNfc(text: string): string {
  return text.normalize('NFC');
}

/** O Windows ignora pontos e espaços no fim do nome e o que vem depois de `:` (fluxo alternativo do NTFS). */
function windowsEquivalent(segment: string): string {
  const colon = segment.indexOf(':');
  return (colon === -1 ? segment : segment.slice(0, colon)).replace(/[. ]+$/, '').toLowerCase();
}

/** Só pontos e espaços (antes de um eventual `:`): é `..`, ou algo que o Windows reduz a `..` ou `.`. */
function isDotsOnly(segment: string): boolean {
  return /^[. ]+(?::|$)/.test(segment);
}

/**
 * Diz se `rel` é um caminho relativo que fica DENTRO da raiz do cérebro. Deve ser conferido antes de toda escrita
 * pedida por um agente. Recusa:
 * - vazio, não texto, ou com byte nulo;
 * - absoluto em qualquer sistema: `/x`, `\x`, `C:\x`, `C:x`, `\\servidor\pasta`;
 * - qualquer segmento `..` (inclusive as variantes que o Windows trata como `..`, como `.. ` e `...`);
 * - a própria raiz (`.`, `./`);
 * - a pasta `.git` em qualquer nível e grafia (`.GIT`, `.git.`, `git~1`): escrever ali é executar código (hooks).
 *
 * A conferência é só de texto. Ela não enxerga link simbólico dentro do cérebro apontando para fora.
 */
export function isSafeRelativePath(rel: unknown): rel is string {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0')) return false;
  const path = toPosixPath(rel);
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;

  let named = 0;
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (isDotsOnly(segment)) return false;
    const equivalent = windowsEquivalent(segment);
    if (equivalent === '.git' || equivalent === 'git~1') return false;
    named++;
  }
  return named > 0;
}

export interface FileNameLengthCheck {
  /** `false` quando o nome não cabe no Linux (e portanto quebraria o `git pull` numa máquina Linux). */
  ok: boolean;
  /** Tamanho do nome em bytes de UTF-8, depois de normalizado para NFC. */
  bytes: number;
  limit: number;
}

/**
 * Confere o tamanho de UM nome de arquivo (não do caminho inteiro) contra o limite de 255 bytes do Linux. Um nome
 * acentuado longo passa no macOS e no Windows e falha no Linux.
 */
export function checkFileNameLength(name: string): FileNameLengthCheck {
  const bytes = Buffer.byteLength(normalizeNfc(name), 'utf8');
  return { ok: bytes <= MAX_FILE_NAME_BYTES, bytes, limit: MAX_FILE_NAME_BYTES };
}
