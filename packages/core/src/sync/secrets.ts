// Scanner de segredos antes de commitar edições de fora e antes de enviar. Achou: o sync bloqueia.
import { scanSecrets } from '../security/index.ts';
import { type GitContext, git, readObjects } from './git.ts';
import type { SecretLocation } from './types.ts';

/** Arquivos maiores que isto não são lidos pelo scanner (anexos, exportações). */
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

/** Mesmo critério do git: um byte nulo no começo do arquivo indica binário. */
export function isBinary(data: Uint8Array): boolean {
  return data.subarray(0, 8000).includes(0);
}

export function scanFile(path: string, data: Uint8Array, where: SecretLocation['where']): SecretLocation[] {
  if (data.length > MAX_SCAN_BYTES || isBinary(data)) return [];
  return scanSecrets(Buffer.from(data).toString('utf8')).map((finding) => ({
    path,
    line: finding.line,
    column: finding.column,
    rule: finding.rule,
    description: finding.description,
    where,
  }));
}

function lineAt(text: string, line: number): string {
  return text.split('\n')[line - 1]?.replace(/\r$/, '') ?? '';
}

/**
 * Procura segredos em tudo que um envio de `target` levaria a um remoto que já tem `up`: cada versão de arquivo
 * criada por qualquer commit do trecho, e não só a última (um segredo apagado num commit seguinte ainda iria no
 * histórico). Uma linha que já está no arquivo do lado remoto não é acusada: enviá-la de novo não vaza nada.
 */
export async function scanOutgoing(ctx: GitContext, up: string | null, target: string): Promise<SecretLocation[]> {
  const { stdout } = await git(ctx, [
    'rev-list',
    '--objects',
    '--filter=object:type=blob',
    target,
    ...(up === null ? [] : ['--not', up]),
  ]);
  const paths = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const space = line.indexOf(' ');
    if (space === -1) continue; // commits vêm sem caminho
    const oid = line.slice(0, space);
    if (!paths.has(oid)) paths.set(oid, line.slice(space + 1));
  }
  if (paths.size === 0) return [];
  const blobs = await readObjects(ctx, paths.keys());
  const found: { hit: SecretLocation; text: string }[] = [];
  for (const [oid, path] of paths) {
    const data = blobs.get(oid);
    if (data === undefined) continue;
    const hits = scanFile(path, data, 'outgoing');
    if (hits.length === 0) continue;
    const text = data.toString('utf8');
    for (const hit of hits) found.push({ hit, text });
  }
  if (found.length === 0) return [];
  const remote =
    up === null
      ? new Map<string, Buffer>()
      : await readObjects(
          ctx,
          found.map(({ hit }) => `${up}:${hit.path}`),
        );
  return found
    .filter(({ hit, text }) => {
      const theirs = remote.get(`${up}:${hit.path}`)?.toString('utf8');
      if (theirs === undefined) return true;
      const mine = lineAt(text, hit.line);
      return !theirs.split('\n').some((line) => line.replace(/\r$/, '') === mine);
    })
    .map(({ hit }) => hit);
}
