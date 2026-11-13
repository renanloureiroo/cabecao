// Scanner de segredos nos VALORES do frontmatter de uma nota. O texto cru de um YAML pode esconder um token que o
// parser entrega inteiro: em `tags: ["\x01ghp_..."]` (ou `"\x67hp_..."`, `"\aghp_..."`) a letra do escape cola no
// começo do token e derruba a fronteira das regras. Aqui cada texto do frontmatter (chaves e valores, em qualquer
// profundidade) passa pelo scanner já decodificado. Complementa o scanner do texto cru; não o substitui.
import { frontmatterStrings } from '../markdown/index.ts';
import { allowMarkerApplies, type SecretFinding, scanSecrets } from './scan.ts';

/** Achado num texto do frontmatter. A linha e a coluna são do arquivo, onde o texto começa. */
export interface FrontmatterSecretFinding extends SecretFinding {
  /** As linhas do arquivo que o texto ocupa, como estão no arquivo (para conferir se já estavam commitadas). */
  readonly source: string;
}

export interface ScanFrontmatterOptions {
  /**
   * Respeitar o marcador `cabecao:allow-secret` na linha do YAML (ou sozinho na linha anterior). O padrão é `true`;
   * use `false` para texto que não foi o usuário quem escreveu.
   */
  readonly honorAllowMarker?: boolean;
}

/**
 * Procura segredos nos textos do frontmatter de `text` (uma nota inteira, com o frontmatter no começo). Sem
 * frontmatter, devolve lista vazia.
 */
export function scanFrontmatterSecrets(text: string, options: ScanFrontmatterOptions = {}): FrontmatterSecretFinding[] {
  const strings = frontmatterStrings(text);
  if (strings.length === 0) return [];
  const honor = options.honorAllowMarker ?? true;
  const lines = honor ? text.split('\n') : [];
  const findings: FrontmatterSecretFinding[] = [];
  for (const item of strings) {
    for (const finding of scanSecrets(item.value, { honorAllowMarker: false })) {
      if (honor && allowMarkerApplies(lines[item.line - 1] ?? '', lines[item.line - 2])) continue;
      findings.push({ ...finding, line: item.line, column: item.column, source: item.source });
    }
  }
  return findings;
}
