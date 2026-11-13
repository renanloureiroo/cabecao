import { join, resolve } from 'node:path';
import type { InitResult, InitStep, InitWarning } from '@cabecao/core';
import { connectLaterStep, initBrain, remoteUrlProblem, resolveRemoteArg } from '@cabecao/core';
import { homeDir, machineConfigDir, toCliError, withBrain } from '../brain.ts';
import type { DoctorReport } from '../doctor/checks.ts';
import { renderReport } from '../doctor/checks.ts';
import { UsageError } from '../errors.ts';
import type { ClientId, Location } from '../install-client/clients.ts';
import { resolveLaunch } from '../install-client/launch.ts';
import type { ClientReport } from '../install-client/register.ts';
import { detectClients, registerClients, reportText } from '../install-client/register.ts';
import { indent, plural } from '../text.ts';
import type { CommandContext, CommandResult } from '../types.ts';
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
  doctor?: DoctorReport | { error: string };
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
    lines.push('O que fazer: escolha outra pasta com --dir <pasta>, ou esvazie esta e repita o comando.');
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

function successText(data: Required<InitData>): string {
  const { init } = data;
  const paragraphs: string[] = [];
  paragraphs.push(`Pasta do cérebro: ${init.root}${init.machine === null ? '' : ` (máquina ${init.machine})`}`);
  paragraphs.push(
    [`Repositório: ${init.message}`, ...warningLines(init.warnings).map((line) => `  ${line}`)].join('\n'),
  );

  const { index } = data;
  paragraphs.push(
    'error' in index
      ? `Índice local: não consegui montar agora (${index.error}). Ele é montado no próximo uso; rode "cabecao status" para ver.`
      : `Índice local: ${plural(index.notes, 'nota indexada', 'notas indexadas')}${index.ms === null ? '' : ` em ${index.ms} ms`}.`,
  );

  const { clients } = data;
  if (clients.skipped) {
    paragraphs.push('Clientes de IA: pulado (--no-clients). Para registrar depois: cabecao install-client --all');
  } else if ('error' in clients) {
    paragraphs.push(`Clientes de IA: não consegui registrar (${clients.error}). Tente: cabecao install-client --all`);
  } else if (clients.detected.length === 0) {
    paragraphs.push(
      'Clientes de IA: nenhum encontrado nesta máquina. Depois de instalar um, rode: cabecao install-client --all',
    );
  } else {
    paragraphs.push(`Clientes de IA:\n${indent(reportText(clients.reports))}`);
  }

  const { doctor } = data;
  paragraphs.push(
    'error' in doctor
      ? `Diagnóstico: não rodou (${doctor.error}). Rode "cabecao doctor".`
      : `Diagnóstico (cabecao doctor, sem consultar o remoto de novo):\n${renderReport(doctor, '  ')}`,
  );

  const steps = nextSteps(init);
  if (steps.length > 0) paragraphs.push(['Próximos passos:', ...steps.map((step) => `  - ${step}`)].join('\n'));
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

  // 1 e 2: cria, baixa ou adota, conforme o que o núcleo encontrar no remoto.
  let result: InitResult;
  try {
    result = await initBrain({
      dir,
      ...(url === undefined ? {} : { url }),
      ...(typeof machine === 'string' ? { machine } : {}),
      configDir: machineConfigDir(ctx),
      hooks: {
        onStep: (step) => {
          if (!ctx.json) ctx.stderr.write(`cabecao: ${STEP_TEXT[step]}...\n`);
        },
      },
    });
  } catch (error) {
    throw toCliError(error);
  }
  if (!result.ok) {
    if (!ctx.json) ctx.stderr.write(`${failureText(result)}\n`);
    return { code: 1, data: { init: result } satisfies InitData };
  }

  // 3. Índice local.
  if (!ctx.json) ctx.stderr.write('cabecao: montando o índice local...\n');
  const index = await indexStep(ctx, result.root);
  // 4. Clientes de IA.
  const clients = await clientsStep(ctx, result.root);
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
  const data: Required<InitData> = { init: result, index, clients, doctor };
  return { data, text: successText(data) };
}
