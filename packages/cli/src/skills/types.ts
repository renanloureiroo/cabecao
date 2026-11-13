/** Um arquivo de uma skill: caminho relativo à pasta da skill (com `/`) e o conteúdo, em UTF-8 com LF. */
export interface SkillFile {
  readonly path: string;
  readonly content: string;
}

/** Uma skill do Cabeção, embutida a partir de `integrations/skills/<name>/` (`content.ts`, gerado). */
export interface SkillSource {
  readonly name: string;
  readonly description: string;
  readonly files: readonly SkillFile[];
}
