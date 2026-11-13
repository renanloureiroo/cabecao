// `cabecao obsidian setup [--dry-run] [--force] [--remove]` e `cabecao obsidian clipper` (doc 09).
//
// O setup configura o `.obsidian/` do cérebro para visualização (cores do grafo, tipos das propriedades, links e o
// arquivo morto fora da busca) mesclando com o que já existe, e grava os painéis (`.base`) e o modelo do Web Clipper
// em `dashboards/`. Só a CLI faz isso: não há tool do MCP para mexer em `.obsidian/` ou em `dashboards/`.
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ObsidianSettings, ObsidianSettingsFile } from '@cabecao/core';
import {
  CLIPPER_TEMPLATE_PATH,
  contentHash,
  dashboardFiles,
  FileChangedError,
  fileStamp,
  lineDiff,
  OBSIDIAN_DIR,
  OBSIDIAN_SETTINGS_FILES,
  obsidianSettings,
  PREVIOUS_DASHBOARD_HASHES,
  readBrainConfig,
  webClipperTemplate,
  webClipperTemplateFile,
  writeFileAtomic,
} from '@cabecao/core';
import { resolveBrain, toCliError } from '../brain.ts';
import { CliError, UsageError } from '../errors.ts';
import { obsidianPresence } from '../obsidian/detect.ts';
import type { Added } from '../obsidian/merge.ts';
import { addedNothing, mergeAdded, mergeSettingsFile, removeAdded } from '../obsidian/merge.ts';
import { didYouMean } from '../suggest.ts';
import { indent } from '../text.ts';
import type { CommandContext, CommandResult } from '../types.ts';

/** Registro do que o setup acrescentou nesta máquina (local, fora do git): é o que o `--remove` tira. */
export const SETUP_RECORD = '.cabecao/obsidian-setup.json';
/** Cópias dos arquivos do `.obsidian/` como estavam antes da primeira alteração do Cabeção (local, fora do git). */
export const BACKUP_DIR = '.cabecao/backups/obsidian';

interface SetupRecord {
  version: 1;
  /** O que foi acrescentado a cada arquivo do `.obsidian/`, e o hash do texto quando o Cabeção o criou. */
  settings: Partial<Record<ObsidianSettingsFile, Added & { createdHash?: string }>>;
  /** Arquivos gerados (painéis, modelo do Web Clipper): caminho → hash do conteúdo gravado. */
  files: Record<string, string>;
}

type FileStatus = 'created' | 'updated' | 'unchanged' | 'kept' | 'invalid' | 'deleted';

interface FileReport {
  path: string;
  status: FileStatus;
  detail?: string;
  kept?: string[];
  diff?: string;
}

const abs = (root: string, rel: string): string => join(root, ...rel.split('/'));
const lf = (text: string): string => text.replace(/\r\n/g, '\n');

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readRecord(root: string): Promise<SetupRecord | null> {
  const text = await readOptional(abs(root, SETUP_RECORD));
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as SetupRecord;
    return value?.version === 1 ? { version: 1, settings: value.settings ?? {}, files: value.files ?? {} } : null;
  } catch {
    return null;
  }
}

/** Grava `text` em `rel` de forma atômica, recusando se o arquivo mudou desde a leitura. */
async function writeChecked(
  root: string,
  rel: string,
  text: string,
  stamp: Awaited<ReturnType<typeof fileStamp>>,
): Promise<void> {
  const path = abs(root, rel);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFileAtomic(path, text, { ifUnchangedSince: stamp });
  } catch (error) {
    if (error instanceof FileChangedError) {
      throw new CliError(
        `${rel} mudou enquanto era lido (o Obsidian está aberto?); nada mais foi gravado. Rode de novo.`,
        {
          code: 'obsidian_changed',
          cause: error,
        },
      );
    }
    throw error;
  }
}

/** Primeira alteração de um arquivo do `.obsidian/`: guarda o original em `.cabecao/backups/obsidian/`. */
async function backup(root: string, file: string): Promise<string | null> {
  const target = abs(root, `${BACKUP_DIR}/${file}.bak`);
  await mkdir(dirname(target), { recursive: true });
  try {
    await copyFile(abs(root, `${OBSIDIAN_DIR}/${file}`), target, constants.COPYFILE_EXCL);
    return `${BACKUP_DIR}/${file}.bak`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw error;
  }
}

async function guardOpen(ctx: CommandContext, root: string, dryRun: boolean): Promise<string[]> {
  const presence = await obsidianPresence(root, ctx);
  if (presence.markedOpen && presence.running === true) {
    if (!dryRun && ctx.values.force !== true) {
      throw new CliError('o Obsidian está aberto com este cérebro: ele regravaria a configuração por cima', {
        code: 'obsidian_open',
        hint: 'Feche o Obsidian (ou só este vault) e rode de novo. Para gravar mesmo assim, use --force.',
      });
    }
    return [
      'O Obsidian parece estar aberto com este cérebro: feche-o antes de gravar, senão ele regrava a configuração.',
    ];
  }
  if (presence.running === true) {
    return [
      'O Obsidian está rodando: se este cérebro estiver aberto nele, feche o vault antes (ele regrava a configuração).',
    ];
  }
  if (presence.markedOpen) {
    return ['O Obsidian abre este cérebro ao iniciar: não o abra enquanto o setup roda.'];
  }
  return [];
}

/** Painéis e modelo do Web Clipper: nome, conteúdo e versões anteriores conhecidas. */
function generatedFiles(): Array<{ path: string; content: string; previous: readonly string[] }> {
  return [
    ...dashboardFiles().map((file) => ({
      path: file.path,
      content: file.content,
      previous: PREVIOUS_DASHBOARD_HASHES[file.path] ?? [],
    })),
    { path: CLIPPER_TEMPLATE_PATH, content: webClipperTemplateFile(), previous: [] },
  ];
}

function describeAdded(added: Added): string {
  const parts: string[] = [];
  if ((added.keys?.length ?? 0) > 0) parts.push(`chaves ${added.keys?.join(', ')}`);
  for (const [key, items] of Object.entries(added.items ?? {})) {
    if (items.length > 0) parts.push(`${key} += ${items.join(', ')}`);
  }
  if ((added.groups?.length ?? 0) > 0) parts.push(`${added.groups?.length} grupo(s) de cor`);
  if ((added.types?.length ?? 0) > 0) parts.push(`${added.types?.length} tipo(s) de propriedade`);
  return parts.join('; ');
}

async function setup(
  ctx: CommandContext,
  root: string,
  want: ObsidianSettings,
  dryRun: boolean,
): Promise<CommandResult> {
  const warnings = await guardOpen(ctx, root, dryRun);
  const record: SetupRecord = (await readRecord(root)) ?? { version: 1, settings: {}, files: {} };
  const reports: FileReport[] = [];
  const backups: string[] = [];
  let invalid = 0;

  for (const file of OBSIDIAN_SETTINGS_FILES) {
    const rel = `${OBSIDIAN_DIR}/${file}`;
    const stamp = await fileStamp(abs(root, rel));
    const current = stamp === null ? null : await readFile(abs(root, rel), 'utf8');
    let outcome: ReturnType<typeof mergeSettingsFile>;
    try {
      outcome = mergeSettingsFile(file, current, want);
    } catch (error) {
      invalid++;
      reports.push({ path: rel, status: 'invalid', detail: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (current !== null && outcome.text === current) {
      reports.push({ path: rel, status: 'unchanged', ...(outcome.kept.length > 0 ? { kept: [...outcome.kept] } : {}) });
      continue;
    }
    reports.push({
      path: rel,
      status: current === null ? 'created' : 'updated',
      detail: current === null ? 'criado' : describeAdded(outcome.added),
      ...(outcome.kept.length > 0 ? { kept: [...outcome.kept] } : {}),
      diff: lineDiff(current ?? '', outcome.text, [`a/${rel}`, `b/${rel}`]),
    });
    if (dryRun) continue;
    if (current !== null) {
      const saved = await backup(root, file);
      if (saved !== null) backups.push(saved);
    }
    await writeChecked(root, rel, outcome.text, stamp);
    if (!addedNothing(outcome.added)) {
      const previous = record.settings[file];
      record.settings[file] = {
        ...mergeAdded(previous, outcome.added),
        ...(outcome.added.created === true
          ? { createdHash: contentHash(outcome.text) }
          : previous?.createdHash === undefined
            ? {}
            : { createdHash: previous.createdHash }),
      };
    }
  }

  for (const file of generatedFiles()) {
    const stamp = await fileStamp(abs(root, file.path));
    const current = stamp === null ? null : await readFile(abs(root, file.path), 'utf8');
    if (current !== null && lf(current) === file.content) {
      reports.push({ path: file.path, status: 'unchanged' });
      continue;
    }
    if (current !== null && !file.previous.includes(contentHash(current))) {
      reports.push({
        path: file.path,
        status: 'kept',
        detail:
          'diferente do que o Cabeção gera (editado por você): mantido. Apague-o e rode de novo para ter o atual.',
      });
      continue;
    }
    reports.push({ path: file.path, status: current === null ? 'created' : 'updated' });
    if (dryRun) continue;
    await writeChecked(root, file.path, file.content, stamp);
    record.files[file.path] = contentHash(file.content);
  }

  const changed = reports.some((report) => report.status === 'created' || report.status === 'updated');
  if (!dryRun && changed) {
    await mkdir(dirname(abs(root, SETUP_RECORD)), { recursive: true });
    await writeFileAtomic(abs(root, SETUP_RECORD), `${JSON.stringify(record, null, 2)}\n`);
  }

  const lines = [`Obsidian: ${root}${dryRun ? ' (simulação: nada foi gravado)' : ''}`];
  lines.push(...formatReports(reports));
  if (backups.length > 0) lines.push(`Cópia dos originais: ${backups.join(', ')}`);
  if (!changed) lines.push('Nada a mudar: o cérebro já está configurado para o Obsidian.');
  else if (!dryRun) {
    lines.push(
      'Pronto. Abra a pasta do cérebro no Obsidian ("Open folder as vault"). Para importar o modelo do Web Clipper:',
      `extensão > Settings > Templates > Import > ${CLIPPER_TEMPLATE_PATH}. Para desfazer: "cabecao obsidian setup --remove".`,
    );
  }
  for (const warning of warnings) lines.push(`Aviso: ${warning}`);
  return {
    code: invalid > 0 ? 1 : 0,
    data: { root, dry_run: dryRun, files: reports, backups, warnings },
    text: lines.join('\n'),
  };
}

function formatReports(reports: readonly FileReport[], removing = false): string[] {
  const mark: Record<FileStatus, string> = {
    created: '+',
    updated: '~',
    unchanged: '=',
    kept: '!',
    invalid: '✗',
    deleted: '-',
  };
  const word: Record<FileStatus, string> = {
    created: 'criado',
    updated: removing ? 'alterado' : 'mesclado',
    unchanged: 'sem mudanças',
    kept: 'mantido',
    invalid: 'não tocado',
    deleted: 'removido',
  };
  const lines: string[] = [];
  for (const report of reports) {
    const detail = report.detail === undefined || report.detail === word[report.status] ? '' : `: ${report.detail}`;
    lines.push(`${mark[report.status]} ${report.path} (${word[report.status]})${detail}`);
    for (const kept of report.kept ?? []) lines.push(`    mantido como você tinha: ${kept}`);
    if (report.diff !== undefined) lines.push(indent(report.diff, '    '));
  }
  return lines;
}

async function remove(
  ctx: CommandContext,
  root: string,
  want: ObsidianSettings,
  dryRun: boolean,
): Promise<CommandResult> {
  const record = await readRecord(root);
  if (record === null) {
    throw new CliError('não há registro de "cabecao obsidian setup" neste cérebro, nesta máquina', {
      code: 'nothing_to_remove',
      hint: `O registro fica em ${SETUP_RECORD} só na máquina que rodou o setup. Para voltar ao que havia antes, copie de volta os arquivos de ${BACKUP_DIR}/ (sem o .bak) para ${OBSIDIAN_DIR}/, ou use o histórico do git ("git log -- ${OBSIDIAN_DIR}").`,
    });
  }
  const warnings = await guardOpen(ctx, root, dryRun);
  const reports: FileReport[] = [];
  for (const file of OBSIDIAN_SETTINGS_FILES) {
    const added = record.settings[file];
    if (added === undefined) continue;
    const rel = `${OBSIDIAN_DIR}/${file}`;
    const stamp = await fileStamp(abs(root, rel));
    if (stamp === null) continue;
    const current = await readFile(abs(root, rel), 'utf8');
    if (added.createdHash !== undefined && contentHash(current) === added.createdHash) {
      reports.push({ path: rel, status: 'deleted', detail: 'criado pelo Cabeção e sem mudanças desde então' });
      if (!dryRun) await rm(abs(root, rel), { force: true });
      continue;
    }
    let result: { text: string; kept: string[] };
    try {
      result = removeAdded(file, current, added, want);
    } catch (error) {
      reports.push({ path: rel, status: 'invalid', detail: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (result.text === current) {
      reports.push({ path: rel, status: 'unchanged', ...(result.kept.length > 0 ? { kept: result.kept } : {}) });
      continue;
    }
    reports.push({
      path: rel,
      status: 'updated',
      detail: 'tirado o que o Cabeção acrescentou',
      ...(result.kept.length > 0 ? { kept: result.kept } : {}),
      diff: lineDiff(current, result.text, [`a/${rel}`, `b/${rel}`]),
    });
    if (dryRun) continue;
    await backup(root, file);
    await writeChecked(root, rel, result.text, stamp);
  }
  for (const [path, hash] of Object.entries(record.files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const current = await readOptional(abs(root, path));
    if (current === null) continue;
    if (contentHash(current) !== hash) {
      reports.push({ path, status: 'kept', detail: 'mudou depois do setup: fica' });
      continue;
    }
    reports.push({ path, status: 'deleted' });
    if (!dryRun) await rm(abs(root, path), { force: true });
  }
  if (!dryRun) await rm(abs(root, SETUP_RECORD), { force: true });
  const lines = [`Obsidian: ${root} — desfazendo o setup${dryRun ? ' (simulação: nada foi gravado)' : ''}`];
  lines.push(...formatReports(reports, true));
  if (reports.every((report) => report.status === 'unchanged' || report.status === 'kept')) {
    lines.push('Nada a tirar.');
  }
  for (const warning of warnings) lines.push(`Aviso: ${warning}`);
  return { data: { root, dry_run: dryRun, files: reports, warnings }, text: lines.join('\n') };
}

export async function run(ctx: CommandContext): Promise<CommandResult> {
  const [sub, ...rest] = ctx.positionals;
  if (rest.length > 0) throw new UsageError(`argumento inesperado: ${rest.join(' ')}`);
  if (sub === 'clipper') {
    return { data: webClipperTemplate(), text: webClipperTemplateFile().trimEnd() };
  }
  if (sub !== 'setup') {
    throw new UsageError(
      sub === undefined
        ? 'falta o que fazer: "cabecao obsidian setup" ou "cabecao obsidian clipper"'
        : `subcomando desconhecido: ${sub} (use setup ou clipper).${didYouMean(sub, ['setup', 'clipper'], 'obsidian ')}`,
    );
  }
  const root = await resolveBrain(ctx);
  let want: ObsidianSettings;
  try {
    want = obsidianSettings(await readBrainConfig(root));
  } catch (error) {
    throw toCliError(error);
  }
  const dryRun = ctx.values['dry-run'] === true;
  return ctx.values.remove === true ? remove(ctx, root, want, dryRun) : setup(ctx, root, want, dryRun);
}
