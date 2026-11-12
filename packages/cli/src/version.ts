import pkg from '../package.json' with { type: 'json' };

/** Nome do comando. Fica aqui, e não vem do núcleo, para o caminho de `--version` não carregar o núcleo. */
export const CLI_NAME = 'cabecao';

export const VERSION: string = pkg.version;

export const HOMEPAGE: string = pkg.homepage;
