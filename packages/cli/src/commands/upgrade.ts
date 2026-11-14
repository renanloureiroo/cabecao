// `cabecao upgrade [--dry-run]` e `cabecao upgrade --template [--dry-run] [--yes]` (doc 08, "Atualizar").
//
// Sem `--template`: migrações do esquema (`schemaVersion`), com ponto de restauração e um commit por migração. Com
// `--template`: a atualização opcional do modelo do cérebro (`AGENTS.md`, `CLAUDE.md`, linhas do `.gitignore` e do
// `.gitattributes`), que nunca sobrescreve o que você editou sem perguntar.
import type { TemplateItem, UpgradeResult } from '@cabecao/core';
import {
  applyTemplate,
  checkTemplate,
  lineDiff,
  MigrationError,
  SUPPORTED_SCHEMA_VERSION,
  schemaState,
  upgradeBrain,
} from '@cabecao/core';
import { readMachine, resolveBrain } from '../brain.ts';
import { CliError } from '../errors.ts';
import { indent, plural } from '../text.ts';
import type { CommandContext, CommandResult } from '../types.ts';
import { confirm } from '../ui.ts';

function fromMigrationError(error: unknown): unknown {
  if (error instanceof MigrationError) {
    return new CliError(error.message, {
      code: error.code,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      cause: error,
    });
  }
  return error;
}

function upgradeText(result: UpgradeResult, dryRun: boolean): string {
  if (result.status === 'up_to_date') {
    return `Esquema ${result.from}: em dia (este Cabeção usa o ${result.supported}). Nenhuma migração pendente.`;
  }
  const lines = [
    dryRun
      ? `Simulação: ${plural(result.steps.length, 'migração', 'migrações')} do esquema ${result.from} para o ${result.to}. Nada foi gravado.`
      : `Cérebro atualizado do esquema ${result.from} para o ${result.to}, ${plural(result.steps.length, 'commit', 'commits')}.`,
  ];
  for (const step of result.steps) {
    lines.push(
      `  ${step.from} → ${step.to}: ${step.description}${step.commit === null ? '' : ` (commit ${step.commit.slice(0, 10)})`}`,
    );
    for (const change of step.changes.slice(0, 20))
      lines.push(`      ${change.change === 'delete' ? '-' : '~'} ${change.path}`);
    if (step.changes.length > 20) lines.push(`      ... e mais ${step.changes.length - 20}`);
  }
  if (result.restorePoint !== null) {
    lines.push(
      `Ponto de restauração: ${result.restorePoint.tag} (volta tudo com "git reset --hard ${result.restorePoint.tag}").`,
    );
  }
  if (result.session !== null) lines.push(`Desfazer a atualização inteira: cabecao undo --session ${result.session}`);
  for (const note of result.notes) lines.push(`Obs.: ${note}`);
  if (!dryRun) lines.push('Agora rode "cabecao sync". As outras máquinas precisam deste Cabeção ou de um mais novo.');
  return lines.join('\n');
}

const STATE_TEXT: Record<TemplateItem['state'], string> = {
  current: 'igual ao modelo atual',
  outdated: 'modelo de uma versão anterior, sem edição sua: será trocado',
  edited: 'editado por você',
  missing: 'não existe (não é recriado)',
  lines_missing: 'faltam linhas do modelo',
};

async function template(ctx: CommandContext, root: string, dryRun: boolean): Promise<CommandResult> {
  const items = await checkTemplate(root);
  const lines = [`Modelo do cérebro: ${root}${dryRun ? ' (simulação: nada foi gravado)' : ''}`];
  for (const item of items) {
    lines.push(
      `  ${item.path}: ${STATE_TEXT[item.state]}${item.added.length > 0 ? ` (${item.added.join(', ')})` : ''}`,
    );
  }
  const replace: string[] = [];
  for (const item of items.filter((entry) => entry.state === 'edited' && entry.next !== null)) {
    const diff = lineDiff(item.current ?? '', item.next ?? '', [`seu ${item.path}`, 'modelo atual']);
    lines.push(`Diferença entre o seu ${item.path} e o modelo atual:`, indent(diff, '    '));
    if (dryRun) continue;
    let yes = ctx.values.yes === true;
    if (!yes && ctx.prompt !== undefined) {
      ctx.stdout.write(`${lines.join('\n')}\n`);
      lines.length = 0;
      if (ctx.select !== undefined) ctx.stderr.write('A sua versão continua no histórico do git.\n');
      yes = await confirm(
        ctx,
        ctx.select !== undefined
          ? `Trocar o seu ${item.path} pelo modelo atual?`
          : `Trocar o seu ${item.path} pelo modelo atual? A sua versão continua no histórico do git.`,
      );
    }
    if (yes) replace.push(item.path);
  }
  const needed = items.some(
    (item) => item.state === 'outdated' || item.state === 'lines_missing' || item.state === 'edited',
  );
  if (!needed) {
    lines.push('Nada a atualizar.');
    return {
      data: { root, dry_run: dryRun, items: items.map(({ path, state, added }) => ({ path, state, added })) },
      text: lines.join('\n'),
    };
  }
  if (dryRun) {
    lines.push('Rode sem --dry-run para aplicar (os arquivos editados por você só mudam se você confirmar).');
    return {
      data: { root, dry_run: true, items: items.map(({ path, state, added }) => ({ path, state, added })) },
      text: lines.join('\n'),
    };
  }
  let result: Awaited<ReturnType<typeof applyTemplate>>;
  try {
    const machine = (await readMachine(ctx))?.machine;
    result = await applyTemplate(root, items, { replace, ...(machine === undefined ? {} : { machine }) });
  } catch (error) {
    throw fromMigrationError(error);
  }
  for (const written of result.written) {
    lines.push(
      `  ~ ${written.path}: ${written.how === 'replaced' ? 'trocado pelo modelo atual' : 'linhas acrescentadas'}`,
    );
  }
  for (const aside of result.aside) {
    lines.push(`  = ${aside.path}: mantido como está; o modelo atual ficou em ${aside.aside} para você comparar`);
  }
  if (result.commit !== null) {
    lines.push(
      `Commit ${result.commit.slice(0, 10)}; "cabecao undo --op ${result.op}" desfaz. Rode "cabecao sync" depois.`,
    );
  }
  return {
    data: { root, dry_run: false, items: items.map(({ path, state, added }) => ({ path, state, added })), ...result },
    text: lines.join('\n'),
  };
}

export async function run(ctx: CommandContext): Promise<CommandResult> {
  const root = await resolveBrain(ctx);
  const dryRun = ctx.values['dry-run'] === true;
  if (ctx.values.template === true) return template(ctx, root, dryRun);
  let result: UpgradeResult;
  try {
    const machine = (await readMachine(ctx))?.machine;
    result = await upgradeBrain(root, { dryRun, ...(machine === undefined ? {} : { machine }) });
  } catch (error) {
    throw fromMigrationError(error);
  }
  const lines = [upgradeText(result, dryRun)];
  const tpl = (await checkTemplate(root)).filter((item) => item.state === 'outdated' || item.state === 'lines_missing');
  if (tpl.length > 0) {
    lines.push(
      `Modelo do cérebro: há atualização opcional (${tpl.map((item) => item.path).join(', ')}). Veja com "cabecao upgrade --template --dry-run".`,
    );
  }
  const state = await schemaState(root);
  return {
    data: { root, dry_run: dryRun, ...result, schema: state ?? { supported: SUPPORTED_SCHEMA_VERSION } },
    text: lines.join('\n'),
  };
}
