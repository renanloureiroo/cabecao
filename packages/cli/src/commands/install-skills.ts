// `cabecao install-skills [<cliente>...] [--all] [--print] [--remove] [--project] [--instructions]`: instala as skills do
// Cabeção (que ensinam o agente a usar o cérebro pela CLI, sem o servidor MCP) nas pastas de skills dos clientes.
import { join } from 'node:path';
import { homeDir, machineConfigDir } from '../brain.ts';
import { CliError, UsageError } from '../errors.ts';
import { CLIENT_IDS, CLIENTS, isClientId, type Location } from '../install-client/clients.ts';
import { detectClients } from '../install-client/register.ts';
import { INSTRUCTIONS_BLOCK, SKILLS } from '../skills/content.ts';
import type { DirResult, FileOutcome } from '../skills/install.ts';
import { installInto, planInstall, readRegistry, removeFrom, writeRegistry } from '../skills/install.ts';
import type { SkillClientId, SkillScope } from '../skills/targets.ts';
import { isSkillClient, NO_SKILLS, SKILL_CLIENTS, skillsDir } from '../skills/targets.ts';
import { didYouMean } from '../suggest.ts';
import { displayPath, plural } from '../text.ts';
import type { CommandContext, CommandResult } from '../types.ts';

const OUTCOME_TEXT: Readonly<Record<FileOutcome, string>> = {
  installed: 'instalada',
  updated: 'atualizada',
  unchanged: 'já estava em dia',
  kept: 'mantida como está: foi alterada por você (ou é uma skill sua com o mesmo nome)',
  removed: 'removida',
  absent: 'já não existia',
};

/** Uma pasta de destino e os clientes que a leem (Codex, Cursor e Gemini CLI dividem `~/.agents/skills`). */
interface Target {
  dir: string;
  scope: SkillScope;
  clients: SkillClientId[];
}

function targetsFor(ids: readonly SkillClientId[], scope: SkillScope, location: Location, cwd: string): Target[] {
  const byDir = new Map<string, Target>();
  for (const id of ids) {
    const dir = skillsDir(id, scope, location, cwd);
    const target = byDir.get(dir) ?? { dir, scope, clients: [] };
    target.clients.push(id);
    byDir.set(dir, target);
  }
  return [...byDir.values()];
}

const labels = (ids: readonly string[]): string =>
  ids.map((id) => (isClientId(id) ? CLIENTS[id].label : id)).join(', ');

function selected(ctx: CommandContext): string[] {
  const unknown = ctx.positionals.filter((name) => !isClientId(name));
  if (unknown.length > 0) {
    const [first = ''] = unknown;
    throw new UsageError(
      `cliente desconhecido: ${unknown.join(', ')}.${didYouMean(first, CLIENT_IDS)} Os clientes são: ${SKILL_CLIENTS.join(', ')}`,
    );
  }
  return [...new Set(ctx.positionals)];
}

/** Texto de uma pasta, com o caminho de cada skill e o que aconteceu. */
function dirText(result: DirResult, home: string): string {
  const lines = [`${labels(result.clients)}: ${displayPath(result.dir, home)}`];
  if (result.sharedWith !== undefined) {
    lines.push(`  as skills continuam lá: ${labels(result.sharedWith)} também usa esta pasta`);
    return lines.join('\n');
  }
  const bySkill = new Map<string, FileOutcome[]>();
  for (const file of result.files) {
    const rel = file.path.slice(result.dir.length + 1).split(/[\\/]/);
    const skill = rel[0] ?? '';
    bySkill.set(skill, [...(bySkill.get(skill) ?? []), file.outcome]);
  }
  for (const [skill, outcomes] of bySkill) {
    const outcome = outcomes.includes('kept')
      ? 'kept'
      : (['installed', 'updated', 'removed', 'unchanged', 'absent'] as const).find((o) => outcomes.includes(o));
    lines.push(`  ${skill}: ${OUTCOME_TEXT[outcome ?? 'unchanged']}`);
  }
  return lines.join('\n');
}

function printText(targets: readonly Target[], plans: ReadonlyMap<string, DirResult['files']>, home: string): string {
  const blocks: string[] = [];
  for (const target of targets) {
    const plan = plans.get(target.dir) ?? [];
    const lines = [`# ${labels(target.clients)}: ${displayPath(target.dir, home)}`];
    for (const file of plan) lines.push(`#   ${displayPath(file.path, home)} (${OUTCOME_TEXT[file.outcome]})`);
    blocks.push(lines.join('\n'));
  }
  const contents = SKILLS.flatMap((skill) =>
    skill.files.map((file) => `# ---- ${skill.name}/${file.path} ----\n${file.content}`),
  );
  return [
    ...blocks,
    '',
    '# Nada foi gravado (--print). O conteúdo de cada skill, igual em todas as pastas:',
    '',
    ...contents,
  ].join('\n');
}

export async function run(ctx: CommandContext): Promise<CommandResult> {
  const all = ctx.values.all === true;
  const print = ctx.values.print === true;
  const remove = ctx.values.remove === true;
  const project = ctx.values.project === true;
  const scope: SkillScope = project ? 'project' : 'user';
  const location: Location = { platform: ctx.platform, env: ctx.env, home: homeDir(ctx) };

  if (ctx.values.instructions === true) {
    if (ctx.positionals.length > 0 || all || remove || project) {
      throw new UsageError('--instructions só mostra o bloco de instruções; não combina com outras opções');
    }
    return {
      data: { action: 'instructions', block: INSTRUCTIONS_BLOCK },
      text: [
        '# Para um agente sem skills que lê um arquivo de instruções (AGENTS.md, GEMINI.md, CLAUDE.md...): cole o',
        '# bloco abaixo no arquivo dele. O Cabeção não edita esse arquivo por você.',
        '',
        INSTRUCTIONS_BLOCK,
      ].join('\n'),
    };
  }
  if (print && remove) throw new UsageError('--print e --remove não combinam');
  const named = selected(ctx);
  if (all && named.length > 0) throw new UsageError('use --all ou o nome dos clientes, não os dois');

  const unsupported = named.filter((id) => !isSkillClient(id));
  if (unsupported.length > 0) {
    const reasons = unsupported.map((id) => NO_SKILLS[id as keyof typeof NO_SKILLS] ?? `${id} não lê skills`);
    throw new CliError(reasons.join('; '), { code: 'no_skills' });
  }
  const configDir = machineConfigDir(ctx);
  const home = location.home;
  const registry = await readRegistry(configDir);

  if (remove) {
    const ids = named.filter(isSkillClient);
    const dirs =
      ids.length === 0
        ? registry.installs.filter((install) => install.scope === scope || all).map((install) => install.dir)
        : [...new Set(ids.map((id) => skillsDir(id, scope, location, ctx.cwd)))];
    const results: DirResult[] = [];
    for (const dir of dirs) {
      const result = await removeFrom(registry, dir, ids.length === 0 ? undefined : ids);
      if (result !== null) results.push(result);
    }
    await writeRegistry(configDir, registry);
    const text =
      results.length === 0
        ? 'Nenhuma skill do Cabeção instalada aí: nada a remover.'
        : results.map((result) => dirText(result, home)).join('\n');
    return { data: { action: 'remove', scope, results }, text };
  }

  let ids: SkillClientId[];
  if (named.length > 0) ids = named.filter(isSkillClient);
  else {
    const detected = (await detectClients(ctx, location)).filter(isSkillClient);
    if (detected.length === 0 && !print) {
      return {
        data: { action: 'install', scope, results: [] },
        text: [
          'Nenhum agente com skills foi detectado nesta máquina.',
          `Depois de instalar um (${SKILL_CLIENTS.join(', ')}), rode "cabecao install-skills" de novo, ou diga o cliente: "cabecao install-skills codex".`,
          'Para um agente sem skills: "cabecao install-skills --instructions" mostra um bloco para colar no AGENTS.md dele.',
        ].join('\n'),
      };
    }
    ids = detected.length === 0 ? [...SKILL_CLIENTS] : detected;
  }
  const targets = targetsFor(ids, scope, location, ctx.cwd);

  if (print) {
    const plans = new Map<string, DirResult['files']>();
    for (const target of targets) plans.set(target.dir, await planInstall(registry, target.dir));
    return {
      data: {
        action: 'print',
        scope,
        targets: targets.map((target) => ({ ...target, files: plans.get(target.dir) ?? [] })),
        skills: SKILLS,
      },
      text: printText(targets, plans, home),
    };
  }

  const results: DirResult[] = [];
  for (const target of targets) results.push(await installInto(registry, target, ctx.version));
  await writeRegistry(configDir, registry);
  const kept = results.flatMap((result) => result.files).filter((file) => file.outcome === 'kept');
  const changed = results.some((result) =>
    result.files.some((file) => file.outcome === 'installed' || file.outcome === 'updated'),
  );
  const lines = results.map((result) => dirText(result, home));
  if (kept.length > 0) {
    lines.push(
      `${plural(kept.length, 'arquivo ficou', 'arquivos ficaram')} como você deixou. Para ver a versão do Cabeção: cabecao install-skills --print`,
    );
  }
  if (changed) lines.push('Abra uma sessão nova do agente para ele carregar as skills.');
  return {
    data: { action: 'install', scope, version: ctx.version, results, registry: join(configDir, 'skills.json') },
    text: lines.join('\n'),
  };
}
