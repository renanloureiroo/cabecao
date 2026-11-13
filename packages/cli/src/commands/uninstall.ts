// `cabecao uninstall [--dry-run] [--keep-cache]`: tira desta máquina tudo o que o Cabeção pôs FORA do cérebro (o npm
// não roda nada ao desinstalar um pacote desde o npm 7): os registros do servidor MCP nos clientes de IA, as skills
// que ele instalou, o sync agendado, a configuração da máquina e o cache (runtime e modelos de embeddings, registros
// das consolidações), e o provedor de respostas do `ask` (o `llm.json` e as chaves guardadas, no cofre do sistema e
// em arquivo). O cérebro NUNCA é tocado: ele é seu, está no git e no remoto.
//
// Mostra o que vai sair e pergunta no terminal (só o usuário roda este comando). `--dry-run` só mostra.
import { existsSync } from 'node:fs';
import { readdir, rm, rmdir } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { cacheDir, readMachineConfig } from '@cabecao/core';
import { dirContext, homeDir, machineConfigDir } from '../brain.ts';
import { CliError } from '../errors.ts';
import type { ClientId, Location } from '../install-client/clients.ts';
import { CLIENT_IDS, CLIENTS } from '../install-client/clients.ts';
import { resolveLaunch } from '../install-client/launch.ts';
import { readRegistrations, registerClients } from '../install-client/register.ts';
import { removeProgramCommand } from '../install-method.ts';
import { CREDENTIALS_FILE, credentialAccount, DPAPI_FILE, deleteKey } from '../llm/credentials.ts';
import { loadLlmMachine } from '../llm/describe.ts';
import { USAGE_FILE } from '../llm/run.ts';
import { scheduleOff, scheduleStatus } from '../schedule/system.ts';
import { readRegistry, removeFrom, writeRegistry } from '../skills/install.ts';
import { displayPath } from '../text.ts';
import type { CommandContext, CommandResult } from '../types.ts';

interface Plan {
  clients: { id: ClientId; label: string; files: string[] }[];
  skills: { dir: string; clients: string[]; files: number }[];
  schedule: { mechanism: string; files: string[] } | null;
  configDir: { path: string; remove: 'all' | 'skip'; why?: string } | null;
  cacheDir: { path: string; remove: 'all' | 'skip'; why?: string } | null;
  /** O provedor de respostas: a pasta, os provedores com chave guardada e os arquivos do Cabeção nela. */
  llm: { dir: string; providers: { id: string; account: string }[]; files: string[] } | null;
  brain: string | null;
  program: string | null;
}

const LLM_FILES = ['llm.json', 'llm-consent.key', CREDENTIALS_FILE, DPAPI_FILE, USAGE_FILE];

async function llmPlan(ctx: CommandContext): Promise<Plan['llm']> {
  const machine = await loadLlmMachine(ctx).catch(() => null);
  if (machine === null || machine.configDir === '') return null;
  const files = LLM_FILES.map((name) => resolve(machine.configDir, name)).filter((path) => existsSync(path));
  const providers = Object.entries(machine.config?.providers ?? {}).flatMap(([id, entry]) =>
    entry.kind === 'http' && entry.key !== 'none' ? [{ id, account: credentialAccount(id, entry) }] : [],
  );
  return files.length === 0 && providers.length === 0 ? null : { dir: machine.configDir, providers, files };
}

/** Uma pasta só é apagada inteira se for a do Cabeção (termina em "cabecao") e não contiver o cérebro. */
function removable(dir: string, brain: string | null): { remove: 'all' | 'skip'; why?: string } {
  const name = basename(dir).toLowerCase();
  if (name !== 'cabecao' && name !== 'cabeção') {
    return {
      remove: 'skip',
      why: 'a pasta não se chama "cabecao" (foi trocada por variável): apague à mão o que for do Cabeção',
    };
  }
  if (brain !== null) {
    const rel = relative(resolve(dir), resolve(brain));
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      return { remove: 'skip', why: 'o cérebro está dentro dela' };
    }
  }
  return { remove: 'all' };
}

async function makePlan(ctx: CommandContext): Promise<Plan> {
  const location: Location = { platform: ctx.platform, env: ctx.env, home: homeDir(ctx) };
  const config = machineConfigDir(ctx);
  const machine = await readMachineConfig(config).catch(() => null);
  const brain = machine?.defaultBrain ?? null;
  // qualquer entrada "cabecao" conta, aponte para que cérebro for: o uninstall tira o Cabeção da máquina inteira
  const launch = await resolveLaunch(ctx, brain ?? '', false);
  const registrations = await readRegistrations(CLIENT_IDS, location, [launch]);
  const clients = registrations
    .map((registration) => ({
      id: registration.client,
      label: registration.label,
      files: registration.files.filter((file) => file.state !== 'missing').map((file) => file.path),
    }))
    .filter((client) => client.files.length > 0);
  const registry = await readRegistry(config);
  const skills = registry.installs.map((install) => ({
    dir: install.dir,
    clients: install.clients,
    files: Object.keys(install.files).length,
  }));
  const status = await scheduleStatus(ctx, { probeWithoutState: false });
  const cache = cacheDir(dirContext(ctx));
  return {
    clients,
    skills,
    schedule: status.registered ? { mechanism: status.mechanism ?? '?', files: status.files } : null,
    configDir: existsSync(config) ? { path: config, ...removable(config, brain) } : null,
    cacheDir:
      existsSync(cache) && ctx.values['keep-cache'] !== true ? { path: cache, ...removable(cache, brain) } : null,
    llm: await llmPlan(ctx),
    brain,
    program: removeProgramCommand(ctx),
  };
}

function planText(plan: Plan, home: string, dryRun: boolean): string {
  const show = (path: string) => displayPath(path, home);
  const lines = [
    dryRun ? 'O que "cabecao uninstall" tiraria desta máquina (nada foi feito):' : 'Vai sair desta máquina:',
  ];
  const empty =
    plan.clients.length === 0 &&
    plan.skills.length === 0 &&
    plan.schedule === null &&
    plan.configDir === null &&
    plan.cacheDir === null &&
    plan.llm === null;
  if (empty) lines.push('  nada: o Cabeção não deixou registro, skill, agendamento, configuração nem cache aqui.');
  for (const client of plan.clients) {
    lines.push(`  registro do servidor MCP no ${client.label}: ${client.files.map(show).join(', ')}`);
  }
  for (const skills of plan.skills) {
    lines.push(`  skills do Cabeção em ${show(skills.dir)} (${skills.clients.join(', ')}; só as que você não alterou)`);
  }
  if (plan.schedule !== null) lines.push(`  sync agendado (${plan.schedule.mechanism})`);
  if (plan.llm !== null) {
    const keys = plan.llm.providers.map((provider) => provider.id);
    lines.push(
      `  respostas (ask): a configuração em ${show(plan.llm.dir)}${keys.length === 0 ? '' : ` e as chaves guardadas de ${keys.join(', ')} (cofre do sistema e arquivo)`}`,
    );
  }
  for (const [label, dir] of [
    ['configuração da máquina', plan.configDir],
    ['cache (runtime e modelos de embeddings, registros)', plan.cacheDir],
  ] as const) {
    if (dir === null) continue;
    lines.push(
      dir.remove === 'all' ? `  ${label}: ${show(dir.path)}` : `  ${label}: ${show(dir.path)} fica (${dir.why})`,
    );
  }
  lines.push('');
  lines.push(
    plan.brain === null
      ? 'O cérebro nunca é tocado.'
      : `Fica: o cérebro em ${show(plan.brain)} (é seu, está no git e no remoto). Apague a pasta à mão se quiser.`,
  );
  if (plan.program !== null) lines.push(`Para tirar o programa depois: ${plan.program}`);
  return lines.join('\n');
}

async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

export async function run(ctx: CommandContext): Promise<CommandResult> {
  const dryRun = ctx.values['dry-run'] === true;
  const home = homeDir(ctx);
  const plan = await makePlan(ctx);
  const text = planText(plan, home, dryRun);
  if (dryRun) return { data: { action: 'dry-run', ...plan }, text };

  if (ctx.prompt === undefined) {
    throw new CliError(
      `"cabecao uninstall" só remove com a confirmação do usuário, num terminal interativo; ${ctx.actor.explanation}`,
      {
        code: 'human_only',
        hint: 'Rode no seu terminal. "cabecao uninstall --dry-run" (que qualquer um roda) só mostra o que sairia.',
      },
    );
  }
  ctx.stderr.write(`${text}\n\n`);
  const answer = (await ctx.prompt('Remover? [s/N] '))?.trim().toLowerCase();
  if (answer !== 's' && answer !== 'sim' && answer !== 'y' && answer !== 'yes') {
    return { code: 1, data: { action: 'cancelled', ...plan }, text: 'Nada foi removido.' };
  }

  const done: string[] = [];
  const problems: string[] = [];
  const location: Location = { platform: ctx.platform, env: ctx.env, home };
  if (plan.clients.length > 0) {
    const reports = await registerClients(
      ctx,
      plan.clients.map((client) => client.id),
      location,
      undefined,
    );
    for (const report of reports) {
      if (report.status === 'failed') problems.push(`${report.label}: ${report.error ?? 'falhou'}`);
      else if (report.status === 'removed') done.push(`registro removido do ${CLIENTS[report.client].label}`);
    }
  }
  const config = machineConfigDir(ctx);
  if (plan.skills.length > 0) {
    const registry = await readRegistry(config);
    for (const skills of plan.skills) {
      const result = await removeFrom(registry, skills.dir, undefined);
      const kept = result?.files.filter((file) => file.outcome === 'kept').length ?? 0;
      done.push(
        `skills removidas de ${displayPath(skills.dir, home)}${kept > 0 ? ` (${kept} arquivo(s) alterado(s) por você ficaram)` : ''}`,
      );
    }
    await writeRegistry(config, registry);
  }
  if (plan.schedule !== null) {
    try {
      const off = await scheduleOff(ctx);
      if (off.status === 'removed') done.push('sync agendado removido');
      problems.push(...off.warnings);
    } catch (error) {
      problems.push(`sync agendado: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // as chaves no cofre do sistema e os arquivos do provedor de respostas, antes de apagar a pasta de configuração
  if (plan.llm !== null) {
    const io = {
      env: ctx.env,
      platform: ctx.platform,
      configDir: plan.llm.dir,
      ...(ctx.credentialRunner === undefined ? {} : { runner: ctx.credentialRunner }),
    };
    let failed = false;
    for (const provider of plan.llm.providers) {
      const left = await deleteKey(io, provider.account).catch((error: unknown) => [
        error instanceof Error ? error.message : String(error),
      ]);
      for (const problem of left) problems.push(`chave de ${provider.id}: ${problem}`);
      failed ||= left.length > 0;
    }
    for (const file of plan.llm.files) {
      // a chave que o cofre recusou apagar fica registrada: o arquivo de chaves e o llm.json ficam para tentar de novo
      if (failed && (file.endsWith('llm.json') || file.endsWith(CREDENTIALS_FILE))) continue;
      await rm(file, { force: true }).catch((error: unknown) =>
        problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
    if (!failed) done.push('respostas (ask): configuração e chaves guardadas apagadas');
  }
  for (const dir of [plan.configDir, plan.cacheDir]) {
    if (dir === null || dir.remove !== 'all') continue;
    try {
      await removeDir(dir.path);
      done.push(`apagado ${displayPath(dir.path, home)}`);
    } catch (error) {
      problems.push(`${dir.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // a pasta de configuração trocada por variável: só o que o Cabeção grava nela
  if (plan.configDir?.remove === 'skip') {
    for (const name of ['config.json', 'schedule.json', 'skills.json']) {
      await rm(resolve(plan.configDir.path, name), { force: true }).catch(() => {});
    }
    if ((await readdir(plan.configDir.path).catch(() => ['x'])).length === 0) {
      await rmdir(plan.configDir.path).catch(() => {});
    }
  }
  const lines = ['Pronto:', ...done.map((line) => `  ${line}`)];
  if (done.length === 0) lines.push('  nada a remover.');
  if (problems.length > 0) lines.push('Não deu para tirar:', ...problems.map((line) => `  ${line}`));
  if (plan.brain !== null) lines.push(`O cérebro continua em ${displayPath(plan.brain, home)}.`);
  if (plan.program !== null) lines.push(`Para tirar o programa: ${plan.program}`);
  return {
    code: problems.length > 0 ? 1 : 0,
    data: { action: 'uninstall', ...plan, done, problems },
    text: lines.join('\n'),
  };
}
