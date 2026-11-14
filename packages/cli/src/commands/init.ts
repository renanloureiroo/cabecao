import { join, resolve } from 'node:path';
import type { InitResult, InitStep, InitWarning } from '@cabecao/core';
import { connectLaterStep, initBrain, remoteUrlProblem, resolveRemoteArg } from '@cabecao/core';
import { homeDir, machineConfigDir, toCliError, withBrain } from '../brain.ts';
import type { DoctorReport } from '../doctor/checks.ts';
import { renderReport } from '../doctor/checks.ts';
import { UsageError } from '../errors.ts';
import type { ClientId, Location } from '../install-client/clients.ts';
import { CLIENTS } from '../install-client/clients.ts';
import { resolveLaunch, stableBin } from '../install-client/launch.ts';
import type { PluginState } from '../install-client/plugin.ts';
import { claudePlugin, pluginActive } from '../install-client/plugin.ts';
import type { ClientReport } from '../install-client/register.ts';
import { detectClients, OUTCOME_TEXT, registerClients, replacedText } from '../install-client/register.ts';
import type { OptionalStep } from '../optional.ts';
import { gatherOptional, optionalSteps, optionalText } from '../optional.ts';
import { displayPath, indent, plural } from '../text.ts';
import type { CommandContext, CommandResult } from '../types.ts';
import type { Paint } from '../ui.ts';
import { banner, paint, progress } from '../ui.ts';
import { runDoctor } from './doctor.ts';

const STEP_TEXT: Readonly<Record<InitStep, string>> = {
  probe: 'consultando o remoto',
  clone: 'baixando o repositório',
  detect: 'vendo o que há no repositório',
  scaffold: 'criando a estrutura do cérebro',
  commit: 'fazendo o commit inicial',
  config: 'gravando a configuração desta máquina',
  push: 'enviando ao remoto',
};

/** Os mesmos passos, como aparecem no progresso do terminal. */
const STEP_LABEL: Readonly<Record<InitStep, string>> = {
  probe: 'Consultando o remoto',
  clone: 'Baixando o repositório',
  detect: 'Vendo o que há no repositório',
  scaffold: 'Criando a estrutura do cérebro',
  commit: 'Commit inicial',
  config: 'Configurando esta máquina',
  push: 'Enviando ao remoto',
};

/** Como ligar um remoto a um cérebro criado só local (o comando `cabecao remote` chega num marco seguinte). */
export function connectLaterText(branch: string | null): string {
  return connectLaterStep(branch);
}

export type IndexStep = { notes: number; ms: number | null } | { error: string };
export type ClientsStep =
  | { skipped: true }
  | { skipped: false; detected: ClientId[]; reports: ClientReport[] }
  | { skipped: false; error: string };

export interface InitData {
  init: InitResult;
  index?: IndexStep;
  clients?: ClientsStep;
  /** O plugin do Cabeção no Claude Code (só lido; o `init` não o instala). */
  plugin?: PluginState;
  doctor?: DoctorReport | { error: string };
  /** O que pedir ao agente para conferir que deu certo. */
  test?: string[];
  /** Até três próximos passos opcionais detectados. */
  optional?: OptionalStep[];
}

const message = (error: unknown): string => {
  const converted = toCliError(error);
  return converted instanceof Error ? converted.message : String(converted);
};

/** Passos seguintes do núcleo (que só citam comandos que existem), com a orientação do remoto no caso local. */
function nextSteps(result: InitResult): string[] {
  const steps = [...result.nextSteps];
  // o núcleo já dá esta orientação no caso local; aqui só se garante que ela esteja lá, uma vez
  const later = connectLaterText(result.branch);
  if (result.case === 'local' && !steps.includes(later)) steps.push(later);
  return steps;
}

function warningLines(warnings: readonly InitWarning[]): string[] {
  return warnings.map((warning) =>
    warning.code === 'public-remote' ? `ATENÇÃO: ${warning.message}` : `Aviso: ${warning.message}`,
  );
}

/** Por que o `init` não deu certo e o que fazer, por caso. Nada ficou para trás em nenhum deles. */
export function failureText(result: InitResult): string {
  const lines = [`O cérebro não foi criado: ${result.message}`];
  if (result.case === 'remote-error') {
    const category = result.error?.category;
    if (category === 'auth') {
      lines.push(
        'O que fazer: o Cabeção usa as credenciais do seu git e nunca pede senha. Configure uma chave SSH (com o ssh-agent) ou salve um token no gerenciador de credenciais, confira com "git ls-remote <url>" e repita.',
      );
    } else if (category === 'network') {
      lines.push('O que fazer: confira a conexão e o endereço, e repita o comando.');
    } else if (category === 'not-found') {
      lines.push(
        'O que fazer: confira o endereço (copie do botão "clonar" do provedor) e se a sua conta tem acesso; repita o comando.',
      );
    } else if (category === 'rejected') {
      lines.push(
        'O que fazer: o servidor recusou o primeiro envio. Libere o envio direto na branch principal (proteção de branch) e repita.',
      );
    } else if (category === 'invalid-url') {
      lines.push(
        'O que fazer: use um endereço como git@github.com:voce/cerebro.git, https://gitlab.com/voce/cerebro.git ou o caminho de um repositório local.',
      );
    } else {
      lines.push('O que fazer: confira o acesso com "git ls-remote <url>" e repita.');
    }
    if (result.error !== null && result.error.detail !== '' && category !== 'invalid-url') {
      lines.push('Saída do git:', indent(result.error.detail));
    }
    lines.push('Ou comece só local agora: rode "cabecao init" sem a URL.');
  } else if (result.case === 'refused') {
    lines.push(
      'O que fazer: use um repositório vazio (de preferência privado) ou um vault de notas em Markdown. Ou comece só local: "cabecao init" sem a URL.',
    );
  } else if (result.case === 'target-not-empty') {
    // o núcleo diz o que fazer para o caso exato (cérebro só local, vault, pasta qualquer)
    for (const step of result.nextSteps) lines.push(`O que fazer: ${step}`);
  }
  lines.push(...warningLines(result.warnings));
  return lines.join('\n');
}

async function indexStep(ctx: CommandContext, root: string): Promise<IndexStep> {
  try {
    // `status` faz a varredura completa do cérebro e devolve as contagens do banco que ela montou.
    const status = await withBrain(ctx, root, (brain) => brain.status());
    return { notes: status.notes.total, ms: status.index.last_scan_ms };
  } catch (error) {
    return { error: message(error) };
  }
}

async function clientsStep(ctx: CommandContext, root: string): Promise<ClientsStep> {
  if (ctx.values['no-clients'] === true) return { skipped: true };
  try {
    const location: Location = { platform: ctx.platform, env: ctx.env, home: homeDir(ctx) };
    const detected = await detectClients(ctx, location);
    if (detected.length === 0) return { skipped: false, detected, reports: [] };
    const launch = await resolveLaunch(ctx, root, false);
    return { skipped: false, detected, reports: await registerClients(ctx, detected, location, launch) };
  } catch (error) {
    return { skipped: false, error: message(error) };
  }
}

const AGENT_ACTION: Readonly<Record<string, string>> = {
  installed: 'servidor MCP registrado',
  updated: 'registro do servidor MCP atualizado',
  unchanged: 'servidor MCP já estava registrado',
};

/** Uma linha por agente detectado: o que ficou configurado nele. */
function agentLines(clients: ClientsStep, plugin: PluginState | undefined, home: string, p: Paint): string[] {
  if (clients.skipped) {
    return ['Agentes: pulados (--no-clients). Para registrar depois: cabecao install-client --all'];
  }
  if ('error' in clients) {
    return [`Agentes: não consegui registrar (${clients.error}). Tente: cabecao install-client --all`];
  }
  if (clients.detected.length === 0) {
    return [
      'Agentes: nenhum encontrado nesta máquina.',
      '  Depois de instalar um (Claude Code, Codex, Cursor, VS Code, Antigravity), rode: cabecao install-client --all',
    ];
  }
  const width = Math.max(...clients.reports.map((report) => report.label.length));
  const lines = [p.bold('Agentes:')];
  for (const report of clients.reports) {
    const label = report.label.padEnd(width);
    if (report.status === 'failed') {
      lines.push(
        `  ${label}  não registrado: ${report.error ?? 'falhou'} (rode "cabecao install-client ${report.client}")`,
      );
      continue;
    }
    // onde ficou o registro é detalhe do `cabecao doctor`; aqui, só o que aconteceu
    lines.push(`  ${label}  ${p.dim(AGENT_ACTION[report.status] ?? OUTCOME_TEXT[report.status])}`);
    if (report.replaced !== undefined) lines.push(`    ${replacedText(report.replaced)}`);
    for (const file of report.files) {
      if (file.backup !== undefined) lines.push(`    original guardado em ${displayPath(file.backup, home)}`);
      if (file.replaced !== undefined) lines.push(`    ${replacedText(file.replaced)}`);
    }
    const notice = CLIENTS[report.client].notice;
    if (notice !== undefined) lines.push(`    aviso: ${notice}`);
    if (report.client === 'claude-code' && plugin !== undefined && pluginActive(plugin)) {
      lines.push(
        `    ATENÇÃO: o plugin do Cabeção também está instalado no Claude Code${plugin.version === null ? '' : ` (versão ${plugin.version})`}: com os dois, o agente vê as tools em dobro. Fique com um: "cabecao install-client --remove claude-code" tira o registro direto (o plugin já traz o servidor).`,
      );
    }
  }
  lines.push(p.dim('  Reinicie os que estiverem abertos.'));
  return lines;
}

/** O teste do primeiro sucesso: o que pedir ao agente e como conferir daqui. */
function testLines(clients: ClientsStep): string[] {
  const first =
    !clients.skipped && !('error' in clients)
      ? clients.reports.find((report) => report.status !== 'failed')?.label
      : undefined;
  return [
    first === undefined
      ? '1. Depois de conectar um agente, peça a ele: "guarde que eu prefiro respostas curtas, em tópicos"'
      : `1. No ${first}, peça: "guarde que eu prefiro respostas curtas, em tópicos"`,
    '2. Numa conversa nova, pergunte: "como eu prefiro as respostas?"',
    '3. Ou confira aqui: cabecao search "respostas curtas"',
  ];
}

function successText(data: Required<InitData>, home: string, p: Paint): string {
  const { init } = data;
  const paragraphs: string[] = [];
  const where = displayPath(init.root, home);
  const machine = init.machine === null ? '' : ` (máquina ${init.machine})`;
  paragraphs.push(
    init.remote === null
      ? `${p.bold('Pronto.')} Seu cérebro está em ${where}${machine}, só nesta máquina.`
      : `${p.bold('Pronto.')} Seu cérebro está em ${where}${machine} e em ${init.remote}.`,
  );
  const { index } = data;
  paragraphs.push(
    [
      init.message.replaceAll(init.root, where),
      ...warningLines(init.warnings),
      'error' in index
        ? `Índice local: não consegui montar agora (${index.error}). Ele é montado no próximo uso.`
        : `Índice local: ${plural(index.notes, 'nota indexada', 'notas indexadas')}${index.ms === null ? '' : ` em ${index.ms} ms`}.`,
    ].join('\n'),
  );
  const adopted =
    init.case === 'adopted' ? init.nextSteps.find((step) => step.startsWith('O cérebro é a pasta')) : undefined;
  if (adopted !== undefined) paragraphs.push(`Obsidian: ${adopted.replaceAll(init.root, where)}`);

  paragraphs.push(agentLines(data.clients, data.plugin, home, p).join('\n'));
  paragraphs.push([p.bold('Teste agora:'), ...data.test.map((line) => `  ${line}`)].join('\n'));
  if (data.optional.length > 0) {
    paragraphs.push([p.bold('Opcional:'), optionalText(data.optional)].join('\n'));
  }

  const { doctor } = data;
  if ('error' in doctor) paragraphs.push(`Diagnóstico: não rodou (${doctor.error}). Rode "cabecao doctor".`);
  else {
    const { ok, warn, fail } = doctor.summary;
    // os avisos ficam para o `cabecao doctor` (a linha abaixo já os conta); aqui, só o que falhou
    const pending = doctor.checks.filter((check) => check.status === 'fail');
    const head = p.dim(
      `Diagnóstico: ${ok} ok, ${plural(warn, 'aviso', 'avisos')}, ${plural(fail, 'falha', 'falhas')}. Detalhes: cabecao doctor`,
    );
    paragraphs.push(
      pending.length === 0 ? head : `${head}\n${renderReport({ ...doctor, checks: pending }, '  ').split('\n\n')[0]}`,
    );
  }

  const steps = nextSteps(init).filter((step) => step !== adopted);
  if (steps.length > 0) paragraphs.push([p.bold('Depois:'), ...steps.map((step) => `  - ${step}`)].join('\n'));
  return paragraphs.join('\n\n');
}

function targetDir(ctx: CommandContext): string {
  const dir = ctx.values.dir;
  const brain = ctx.values.brain;
  if (dir === '') throw new UsageError('a opção --dir precisa de uma pasta');
  // `--brain` (só a opção, não a variável CABECAO_BRAIN) também diz a pasta, por ser "a pasta do cérebro".
  if (typeof dir === 'string' && typeof brain === 'string' && resolve(ctx.cwd, dir) !== resolve(ctx.cwd, brain)) {
    throw new UsageError('--dir e --brain apontam para pastas diferentes; use só --dir');
  }
  const chosen = typeof dir === 'string' ? dir : typeof brain === 'string' ? brain : undefined;
  return resolve(ctx.cwd, chosen ?? join(homeDir(ctx), 'cabecao'));
}

export async function run(ctx: CommandContext): Promise<CommandResult> {
  if (ctx.positionals.length > 1) {
    throw new UsageError(`só uma URL por vez (veio também: ${ctx.positionals.slice(1).join(' ')})`);
  }
  const rawUrl = ctx.positionals[0];
  // Caminho local relativo vale a partir da pasta atual do usuário; URLs e endereços inválidos passam como vieram
  // (o núcleo explica o problema).
  const url = rawUrl !== undefined && remoteUrlProblem(rawUrl) === null ? resolveRemoteArg(rawUrl, ctx.cwd) : rawUrl;
  const machine = ctx.values.machine;
  if (machine === '') throw new UsageError('a opção --machine precisa de um nome');
  const dir = targetDir(ctx);

  const steps = progress(ctx);
  if (!ctx.json && ctx.style?.stderr === true) {
    ctx.stderr.write(`\n${banner(paint(true, ctx.env), 'Cabeção', 'seu segundo cérebro, em Markdown e git')}\n\n`);
  }
  // 1 e 2: cria, baixa ou adota, conforme o que o núcleo encontrar no remoto.
  let result: InitResult;
  try {
    result = await initBrain({
      dir,
      ...(url === undefined ? {} : { url }),
      ...(typeof machine === 'string' ? { machine } : {}),
      configDir: machineConfigDir(ctx),
      hooks: {
        onStep: (step) => steps.start(STEP_LABEL[step], STEP_TEXT[step]),
      },
    });
  } catch (error) {
    steps.fail();
    throw toCliError(error);
  }
  if (!result.ok) {
    steps.fail();
    if (!ctx.json) ctx.stderr.write(`${failureText(result)}\n`);
    return { code: 1, data: { init: result } satisfies InitData };
  }

  // 3. Índice local.
  steps.start('Montando o índice local', 'montando o índice local');
  const index = await indexStep(ctx, result.root);
  if ('error' in index) steps.fail();
  else steps.done(plural(index.notes, 'nota', 'notas'));
  // 4. Clientes de IA.
  if (ctx.values['no-clients'] !== true) steps.start('Registrando nos agentes');
  const clients = await clientsStep(ctx, result.root);
  if (!clients.skipped) {
    if ('error' in clients) steps.fail();
    else
      steps.done(clients.reports.length === 0 ? 'nenhum encontrado' : clients.reports.map((r) => r.label).join(', '));
  }
  steps.start('Conferindo a instalação');
  // 5. Diagnóstico. O remoto acabou de responder ao próprio init: não é consultado de novo.
  let doctor: DoctorReport | { error: string };
  try {
    doctor = await runDoctor(ctx, {
      brain: { root: result.root },
      offline: true,
      nodeVersion: process.versions.node,
    });
  } catch (error) {
    doctor = { error: message(error) };
  }
  const location: Location = { platform: ctx.platform, env: ctx.env, home: homeDir(ctx) };
  const plugin = await claudePlugin(location);
  const facts = await gatherOptional(ctx, result.root, {
    hasRemote: result.remote !== null,
    stableInstall: (await stableBin(ctx.binPath)) !== undefined,
  });
  const data: Required<InitData> = {
    init: result,
    index,
    clients,
    plugin,
    doctor,
    test: testLines(clients),
    optional: optionalSteps(facts),
  };
  steps.done();
  if (ctx.style?.stderr === true && !ctx.json) ctx.stderr.write('\n');
  return { data, text: successText(data, location.home, paint(ctx.style?.stdout === true, ctx.env)) };
}
