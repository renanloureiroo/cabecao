// O `.cabecao.json` no sync (ADR 35: arquivo de configuração nunca se perde e só é alterado quando necessário).
//
// - Um `.cabecao.json` inválido (JSON quebrado ou campo errado) que chega do remoto, commitado por outro cliente git,
//   derrubaria o cérebro nesta máquina: `openBrain` recusa abrir, e o sync seguinte também. Na integração, se o
//   remoto troca a configuração por uma inválida (ou a apaga), fica a versão local válida e a do remoto é preservada
//   numa cópia de conflito (`.cabecao.conflict-<máquina>-<data>.json`), num commit próprio.
// - Se o `.cabecao.json` da pasta de trabalho já está inválido, o sync roda mesmo assim, com a última versão válida
//   do histórico (ou a padrão), justamente para poder receber a correção feita em outra máquina.
import { runGit } from '../git/index.ts';
import type { BrainConfig } from '../vault/index.ts';
import {
  BRAIN_CONFIG_FILE,
  defaultBrainConfig,
  isInvalidConfigError,
  parseBrainConfig,
  readBrainConfig,
  VaultError,
} from '../vault/index.ts';
import { commitMessage, type SyncContext } from './context.ts';
import { commitTree, editTree, readObjects, revParse, treeOf } from './git.ts';
import { conflictCopyPath } from './layout.ts';
import type { SyncConflict } from './types.ts';

/** Quantas versões do `.cabecao.json` no histórico o sync tenta antes de cair na configuração padrão. */
const HISTORY_LIMIT = 200;

/** Por que um texto de `.cabecao.json` não vale, ou `null` se vale. Um esquema mais novo vale (pede atualizar). */
export function configProblem(text: string): string | null {
  try {
    parseBrainConfig(text);
    return null;
  } catch (error) {
    if (isInvalidConfigError(error)) return error.message.replace(/^\.cabecao\.json: /, '');
    return null;
  }
}

export interface SyncConfig {
  readonly config: BrainConfig;
  /** Presente quando o `.cabecao.json` da pasta de trabalho está inválido: o motivo e o que foi usado no lugar. */
  readonly problem?: string;
}

/**
 * A configuração com que o sync roda: a da pasta de trabalho; se ela estiver inválida, a última versão válida do
 * histórico do `.cabecao.json` (a partir do HEAD), senão a padrão. Esquema mais novo e arquivo ausente continuam
 * sendo erro (`readBrainConfig`).
 */
export async function loadSyncConfig(root: string, timeoutMs: number): Promise<SyncConfig> {
  try {
    return { config: await readBrainConfig(root) };
  } catch (error) {
    if (!isInvalidConfigError(error)) throw error;
    const reason = error.message.slice(error.message.indexOf(BRAIN_CONFIG_FILE));
    const listed = await runGit(
      ['log', `--max-count=${HISTORY_LIMIT}`, '--format=%H', 'HEAD', '--', BRAIN_CONFIG_FILE],
      { cwd: root, allowFailure: true, timeoutMs },
    );
    for (const sha of listed.exitCode === 0 ? listed.stdout.split('\n').filter(Boolean) : []) {
      const shown = await runGit(['show', `${sha}:${BRAIN_CONFIG_FILE}`], { cwd: root, allowFailure: true, timeoutMs });
      if (shown.exitCode !== 0) continue; // o commit apagou o arquivo
      try {
        return {
          config: parseBrainConfig(shown.stdout),
          problem: `${reason}. O sync rodou com a última versão válida do histórico (commit ${sha.slice(0, 10)}).`,
        };
      } catch {
        // versão inválida também: tenta a anterior
      }
    }
    return {
      config: defaultBrainConfig(),
      problem: `${reason}. Nenhuma versão válida no histórico: o sync rodou com a configuração padrão.`,
    };
  }
}

async function configBlob(ctx: SyncContext, commit: string | null): Promise<string | null> {
  return commit === null ? null : revParse(ctx, `${commit}:${BRAIN_CONFIG_FILE}`);
}

async function blobText(ctx: SyncContext, oid: string): Promise<string> {
  return (await readObjects(ctx, [oid])).get(oid)?.toString('utf8') ?? '';
}

/** Nome de cópia de conflito do `.cabecao.json` que ainda não existe na árvore. */
async function freeCopyPath(ctx: SyncContext, tree: string): Promise<string> {
  const date = ctx.now();
  for (let n = 1; ; n++) {
    const candidate = conflictCopyPath(BRAIN_CONFIG_FILE, ctx.machine, date, n);
    if ((await revParse(ctx, `${tree}:${candidate}`)) === null) return candidate;
  }
}

/**
 * `schemaVersion` do `.cabecao.json` em `commit` quando ele é MAIS NOVO do que este Cabeção entende, senão `null`.
 * O sync de uma máquina antiga para antes de aplicar uma árvore assim: o código antigo regeneraria o `index.md` e
 * reindexaria com as regras velhas um cérebro já migrado. Nada é aplicado nem enviado; as mudanças desta máquina
 * ficam em commits locais até ela ser atualizada (regra de compatibilidade em `migrate/migrations.ts`).
 */
export async function newerSchemaIn(ctx: SyncContext, commit: string): Promise<number | null> {
  const blob = await configBlob(ctx, commit);
  if (blob === null) return null;
  try {
    parseBrainConfig(await blobText(ctx, blob));
    return null;
  } catch (error) {
    if (!(error instanceof VaultError) || error.code !== 'config_schema_too_new') return null;
    try {
      const version = (JSON.parse((await blobText(ctx, blob)).replace(/^﻿/, '')) as { schemaVersion?: unknown })
        .schemaVersion;
      return typeof version === 'number' ? version : null;
    } catch {
      return null;
    }
  }
}

export interface ConfigGuardResult {
  /** Commit novo, sobre `target`, com a versão local de volta e a do remoto na cópia. */
  readonly commit: string;
  readonly conflict: SyncConflict;
}

/**
 * Confere o `.cabecao.json` da árvore integrada (`target`) contra o local (`head`). Só age quando a integração TROCOU
 * a configuração por uma inválida (ou a apagou) e a local é válida: aí cria um commit sobre `target` que devolve a
 * versão local e guarda a do remoto em `.cabecao.conflict-<máquina>-<data>.json`. Configuração válida que chega
 * entra como veio (a de esquema mais novo nem chega aqui: o sync para antes, ver `newerSchemaIn`); uma inválida que já estava aqui não é tocada (é do usuário: `status` e
 * `doctor` dizem como consertar). Devolve `null` quando não precisou fazer nada.
 */
export async function keepValidConfig(
  ctx: SyncContext,
  head: string | null,
  target: string,
): Promise<ConfigGuardResult | null> {
  const theirs = await configBlob(ctx, target);
  const ours = await configBlob(ctx, head);
  if (theirs === ours || ours === null) return null;
  const problem = theirs === null ? 'o arquivo foi apagado' : configProblem(await blobText(ctx, theirs));
  if (problem === null) return null;
  if (configProblem(await blobText(ctx, ours)) !== null) return null;

  const tree = await treeOf(ctx, target);
  const copy = theirs === null ? null : await freeCopyPath(ctx, tree);
  const edited = await editTree(ctx, tree, [
    { path: BRAIN_CONFIG_FILE, oid: ours, mode: '100644' },
    ...(copy === null || theirs === null ? [] : [{ path: copy, oid: theirs, mode: '100644' }]),
  ]);
  const detail =
    copy === null
      ? `- ${BRAIN_CONFIG_FILE}: apagado no remoto; a versão desta máquina foi mantida`
      : `- ${BRAIN_CONFIG_FILE}: a versão do remoto é inválida (${problem}); ficou a desta máquina, e a do remoto está em ${copy}`;
  const message = commitMessage(ctx, {
    action: 'conflict',
    body: [`conflict: ${BRAIN_CONFIG_FILE} inválido vindo do remoto`, detail],
    numFiles: copy === null ? 1 : 2,
  });
  return {
    commit: await commitTree(ctx, edited, [target], message),
    conflict: { path: BRAIN_CONFIG_FILE, kind: 'invalid', ...(copy === null ? {} : { copy }), reason: problem },
  };
}
