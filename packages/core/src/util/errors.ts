/** Verdadeiro quando `error` é um erro do sistema com um dos códigos dados (`ENOENT`, `EEXIST`...). */
export function isErrno(error: unknown, ...codes: string[]): error is NodeJS.ErrnoException {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' && codes.includes(code);
}

/**
 * Códigos que o Windows devolve quando outro processo (antivírus, indexador, outro escritor) está com o arquivo
 * aberto no instante da operação. São passageiros: vale tentar de novo.
 */
export const WINDOWS_TRANSIENT_CODES = ['EPERM', 'EBUSY', 'EACCES'] as const;

export function isWindowsTransient(error: unknown, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && isErrno(error, ...WINDOWS_TRANSIENT_CODES);
}
