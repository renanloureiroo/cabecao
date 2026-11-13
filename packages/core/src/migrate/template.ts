// Atualização do MODELO do cérebro (`cabecao upgrade --template`), separada das migrações do esquema: o `AGENTS.md`,
// o `CLAUDE.md`, o `.gitignore` e o `.gitattributes` que o `init` grava mudam entre versões do Cabeção (o `AGENTS.md`
// das betas 0.1.0-beta.0 e beta.1 ainda manda gravar o handoff com `remember`), mas são arquivos do usuário.
//
// Regra: nunca sobrescreve o que o usuário editou. Um arquivo igual a um modelo de uma versão anterior (conferido pelo
// hash) nunca foi editado e pode ser trocado; um arquivo editado só é trocado se o usuário confirmar (a CLI mostra a
// diferença e pergunta) e, sem confirmação, o modelo novo fica ao lado, em `.cabecao/template/`, para comparar. No
// `.gitignore` e no `.gitattributes` só se ACRESCENTAM as linhas que faltam.
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { commitPaths, formatCommitMessage, runGit } from '../git/index.ts';
import { mergeGitattributes, mergeGitignore } from '../init/merge-lines.ts';
import {
  AGENTS_MD,
  AGENTS_MD_CONTENT,
  CLAUDE_MD,
  CLAUDE_MD_CONTENT,
  GITATTRIBUTES,
  GITIGNORE,
  RECOMMENDED_GITIGNORE_LINES,
  REQUIRED_GITATTRIBUTES_LINES,
} from '../init/template.ts';
import { contentHash } from '../obsidian/dashboards.ts';
import { syncLayout } from '../sync/layout.ts';
import { acquireLock, ulid, writeFileAtomic } from '../util/index.ts';
import { BRAIN_CONFIG_FILE } from '../vault/index.ts';
import { commitTemplate, MigrationError, upgradeMachineName } from './upgrade.ts';

/** Onde o modelo novo de um arquivo editado fica para o usuário comparar (local, fora do git). */
export const TEMPLATE_SIDE_DIR = '.cabecao/template';

/**
 * Hashes (texto com LF) dos modelos que versões publicadas anteriores gravaram. `AGENTS.md`: o das betas
 * 0.1.0-beta.0 e 0.1.0-beta.1 (iguais).
 */
export const PREVIOUS_TEMPLATE_HASHES: Readonly<Record<string, readonly string[]>> = {
  [AGENTS_MD]: ['b4b7f99a761112c55e79247ef76fa6e55639346e41250ed45c90dbdf26733e27'],
  [CLAUDE_MD]: [],
};

export type TemplateState =
  /** Igual ao modelo atual. */
  | 'current'
  /** Igual ao modelo de uma versão anterior: ninguém editou, pode trocar. */
  | 'outdated'
  /** Diferente de qualquer modelo: é do usuário; só troca com confirmação. */
  | 'edited'
  /** Não existe: o usuário pode ter apagado de propósito; não é recriado. */
  | 'missing'
  /** `.gitignore`/`.gitattributes` sem algumas linhas do modelo. */
  | 'lines_missing';

export interface TemplateItem {
  readonly path: string;
  readonly state: TemplateState;
  /** Conteúdo atual (com as quebras de linha do arquivo), quando existe. */
  readonly current: string | null;
  /** Conteúdo que a atualização gravaria; `null` quando não há o que fazer. */
  readonly next: string | null;
  /** Linhas acrescentadas (`lines_missing`). */
  readonly added: readonly string[];
}

const lf = (text: string): string => text.replace(/\r\n/g, '\n');

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function wholeFile(path: string, current: string | null, model: string): TemplateItem {
  if (current === null) return { path, state: 'missing', current, next: null, added: [] };
  if (lf(current) === model) return { path, state: 'current', current, next: null, added: [] };
  const known = PREVIOUS_TEMPLATE_HASHES[path] ?? [];
  const next = current.includes('\r\n') ? model.replace(/\n/g, '\r\n') : model;
  return { path, state: known.includes(contentHash(current)) ? 'outdated' : 'edited', current, next, added: [] };
}

/** Compara os arquivos do modelo do cérebro em `root` com o modelo desta versão. Só lê. */
export async function checkTemplate(root: string): Promise<TemplateItem[]> {
  const items: TemplateItem[] = [];
  for (const [path, model] of [
    [AGENTS_MD, AGENTS_MD_CONTENT],
    [CLAUDE_MD, CLAUDE_MD_CONTENT],
  ] as const) {
    items.push(wholeFile(path, await readOptional(join(root, path)), model));
  }
  const gitignore = (await readOptional(join(root, GITIGNORE))) ?? '';
  const ignore = mergeGitignore(gitignore, RECOMMENDED_GITIGNORE_LINES);
  items.push({
    path: GITIGNORE,
    state: ignore.added.length === 0 ? 'current' : 'lines_missing',
    current: gitignore,
    next: ignore.added.length === 0 ? null : ignore.content,
    added: ignore.added,
  });
  const gitattributes = (await readOptional(join(root, GITATTRIBUTES))) ?? '';
  const attributes = mergeGitattributes(gitattributes, REQUIRED_GITATTRIBUTES_LINES);
  items.push({
    path: GITATTRIBUTES,
    state: attributes.added.length === 0 ? 'current' : 'lines_missing',
    current: gitattributes,
    next: attributes.added.length === 0 ? null : attributes.content,
    added: attributes.added,
  });
  return items;
}

/** Há algo que a atualização do modelo faria sem perguntar (trocar modelo antigo, acrescentar linhas). */
export function templateUpdatable(items: readonly TemplateItem[]): TemplateItem[] {
  return items.filter((item) => item.state === 'outdated' || item.state === 'lines_missing');
}

/**
 * Grava o modelo novo de um arquivo editado em `.cabecao/template/<arquivo>` (local, fora do git), para o usuário
 * comparar e juntar à mão. Devolve o caminho relativo.
 */
export async function writeTemplateAside(root: string, item: TemplateItem): Promise<string> {
  const rel = `${TEMPLATE_SIDE_DIR}/${item.path}`;
  const path = join(root, ...rel.split('/'));
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, item.next ?? '');
  return rel;
}

/**
 * Diferença linha a linha, no estilo do `diff -u` mas sem números de bloco (para mostrar no terminal o que mudaria).
 * Simples (maior subsequência comum), suficiente para arquivos pequenos como o `AGENTS.md`.
 */
export function lineDiff(
  before: string,
  after: string,
  labels: readonly [string, string] = ['antes', 'depois'],
): string {
  const a = lf(before).split('\n');
  const b = lf(after).split('\n');
  if (a.at(-1) === '') a.pop();
  if (b.at(-1) === '') b.pop();
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      row[j] =
        a[i] === b[j]
          ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as number[])[j] as number, row[j + 1] as number);
    }
  }
  const ops: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push(` ${a[i]}`);
      i++;
      j++;
    } else if (
      i < n &&
      (j >= m || ((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number))
    ) {
      // a linha que sai vem antes da que entra, como no diff -u
      ops.push(`-${a[i]}`);
      i++;
    } else {
      ops.push(`+${b[j]}`);
      j++;
    }
  }
  // só as linhas mudadas e duas de contexto em volta; "@@" separa os trechos
  const keep = ops.map(() => false);
  ops.forEach((op, k) => {
    if (op.startsWith(' ')) return;
    for (let c = Math.max(0, k - 2); c <= Math.min(ops.length - 1, k + 2); c++) keep[c] = true;
  });
  const out = [`--- ${labels[0]}`, `+++ ${labels[1]}`];
  let gap = true;
  ops.forEach((op, k) => {
    if (!keep[k]) {
      gap = true;
      return;
    }
    if (gap) out.push('@@');
    gap = false;
    out.push(op);
  });
  return out.join('\n');
}

export interface ApplyTemplateOptions {
  /** Arquivos editados pelo usuário que ele confirmou trocar pelo modelo novo. */
  readonly replace?: readonly string[];
  readonly machine?: string;
  readonly client?: string;
  readonly now?: () => Date;
}

export interface ApplyTemplateResult {
  /** Arquivos gravados, com o que aconteceu. */
  readonly written: ReadonlyArray<{ readonly path: string; readonly how: 'replaced' | 'lines_added' }>;
  /** Arquivos editados que ficaram como estavam, com o modelo novo ao lado (`.cabecao/template/...`). */
  readonly aside: ReadonlyArray<{ readonly path: string; readonly aside: string }>;
  readonly op: string | null;
  readonly commit: string | null;
}

/**
 * Aplica a atualização do modelo: troca os arquivos `outdated` (e os `edited` listados em `replace`), acrescenta as
 * linhas que faltam no `.gitignore` e no `.gitattributes`, e põe tudo num commit (ação `edit`). Os `edited` que não
 * foram confirmados ganham o modelo novo ao lado. Recusa (`dirty`) se algum arquivo a gravar tem mudança fora de
 * commit: a troca levaria junto uma edição que o usuário ainda não salvou no histórico.
 */
export async function applyTemplate(
  root: string,
  items: readonly TemplateItem[],
  options: ApplyTemplateOptions = {},
): Promise<ApplyTemplateResult> {
  const replace = new Set(options.replace ?? []);
  const toWrite = items.filter(
    (item) =>
      item.next !== null &&
      (item.state === 'outdated' ||
        item.state === 'lines_missing' ||
        (item.state === 'edited' && replace.has(item.path))),
  );
  const aside: Array<{ path: string; aside: string }> = [];
  for (const item of items) {
    if (item.state === 'edited' && !replace.has(item.path)) {
      aside.push({ path: item.path, aside: await writeTemplateAside(root, item) });
    }
  }
  if (toWrite.length === 0) return { written: [], aside, op: null, commit: null };

  const lock = await acquireLock(syncLayout(root).worktreeLock, { timeoutMs: 10_000 });
  try {
    const status = await runGit(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...toWrite.map((item) => item.path)],
      { cwd: root },
    );
    if (status.stdout.split('\0').some((entry) => entry.length > 3)) {
      throw new MigrationError(
        'dirty',
        `há mudanças fora de commit em ${toWrite.map((item) => item.path).join(', ')}`,
        'Rode "cabecao sync" (ou faça o commit dessas mudanças) e depois "cabecao upgrade --template" de novo.',
      );
    }
    for (const item of toWrite) await writeFileAtomic(join(root, item.path), item.next ?? '');
    const now = options.now ?? (() => new Date());
    const op = ulid();
    const configText = (await readOptional(join(root, BRAIN_CONFIG_FILE))) ?? '';
    const written = toWrite.map((item) => ({
      path: item.path,
      how: item.state === 'lines_missing' ? ('lines_added' as const) : ('replaced' as const),
    }));
    const message = formatCommitMessage({
      ...commitTemplate(configText),
      date: now(),
      action: 'edit',
      numFiles: written.length,
      body: [
        'edit: modelo do cérebro atualizado (upgrade --template)',
        ...written.map((item) =>
          item.how === 'replaced'
            ? `edit: ${item.path} trocado pelo modelo atual`
            : `edit: ${item.path} com as linhas que faltavam do modelo`,
        ),
      ],
      trailers: { op, machine: await upgradeMachineName(options.machine), client: options.client ?? 'cli' },
    });
    const commit = await commitPaths(
      root,
      written.map((item) => item.path),
      message,
    );
    return { written, aside, op, commit };
  } finally {
    await lock.release();
  }
}
