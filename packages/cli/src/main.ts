import { PRODUCT_NAME } from '@cabecao/core';
import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const HELP = `${PRODUCT_NAME} ${VERSION}
Segundo cérebro pessoal em Markdown e git, para você e seus agentes de IA.

Uso:
  ${PRODUCT_NAME} --version   mostra a versão
  ${PRODUCT_NAME} --help      mostra esta ajuda

Esta versão ainda não tem comandos: eles chegam na 0.1.
${pkg.homepage}
`;

/** Executa a CLI sem tocar no processo: recebe os argumentos e devolve o que escrever e o código de saída. */
export function run(argv: readonly string[]): CliResult {
  const [first] = argv;
  if (first === '--version' || first === '-v') return { code: 0, stdout: `${VERSION}\n`, stderr: '' };
  if (first === undefined || first === '--help' || first === '-h') return { code: 0, stdout: HELP, stderr: '' };
  return {
    code: 2,
    stdout: '',
    stderr: `${PRODUCT_NAME}: comando desconhecido: ${first}\nRode ${PRODUCT_NAME} --help para ver o que existe.\n`,
  };
}

export function main(argv: readonly string[]): void {
  const result = run(argv);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
