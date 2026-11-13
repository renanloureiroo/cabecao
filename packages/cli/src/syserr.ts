// Erros do sistema (permissão negada, disco só de leitura, disco cheio) traduzidos para o que aconteceu, por quê e o
// que fazer, sem o texto cru do Node ("EACCES: permission denied, open '...'"). Sem o núcleo: o roteador usa isto em
// todo erro que chega a ele.
import { CliError } from './errors.ts';

const PERMISSION = new Set(['EACCES', 'EPERM']);

function errnoOf(error: unknown): NodeJS.ErrnoException | undefined {
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 5; depth++) {
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return current as NodeJS.ErrnoException;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** O verbo da operação que falhou, pela chamada de sistema do Node. */
function action(syscall: string | undefined): string {
  if (syscall === undefined) return 'usar';
  if (/^(?:open|read|stat|lstat|scandir|readdir|access|readlink|realpath)/.test(syscall)) return 'abrir';
  if (/^(?:rm|rmdir|unlink)/.test(syscall)) return 'apagar';
  return 'gravar em';
}

/**
 * Um erro de permissão, de disco só de leitura ou de disco cheio, como `CliError` com o que fazer; `undefined` para
 * qualquer outro erro (que segue como está).
 */
export function systemError(error: unknown): CliError | undefined {
  const errno = errnoOf(error);
  if (errno === undefined) return undefined;
  const path = errno.path ?? (errno as { dest?: string }).dest;
  const where = path === undefined ? '' : ` ${path}`;
  const disk = path === undefined ? 'o disco' : `o disco de ${path}`;
  if (PERMISSION.has(errno.code ?? '')) {
    return new CliError(`sem permissão para ${action(errno.syscall)}${where}`, {
      code: 'permission_denied',
      hint: `O seu usuário não pode ${action(errno.syscall)} este caminho. Confira o dono e as permissões (no macOS e no Linux: ls -ld "${path ?? '<caminho>'}") e libere com chmod u+rw, ou aponte o Cabeção para uma pasta sua (--brain, CABECAO_CONFIG_DIR, CABECAO_CACHE_DIR). Não rode o Cabeção com sudo.`,
      cause: error,
    });
  }
  if (errno.code === 'EROFS') {
    return new CliError(`${disk} está montado só para leitura`, {
      code: 'read_only_fs',
      hint: 'Use uma pasta num disco em que dá para gravar (--brain, CABECAO_CONFIG_DIR, CABECAO_CACHE_DIR). Nada foi gravado.',
      cause: error,
    });
  }
  if (errno.code === 'ENOSPC' || errno.code === 'EDQUOT') {
    return new CliError(`${disk} está cheio (ou a sua cota acabou)`, {
      code: 'disk_full',
      hint: 'Libere espaço e rode de novo. O Cabeção grava cada arquivo de uma vez: nada ficou gravado pela metade.',
      cause: error,
    });
  }
  return undefined;
}
