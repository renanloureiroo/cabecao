// `cabecao consolidate --run`: a consolidação inteira sem ninguém olhando.
//
// 1. `start` pela CLI (o usuário): ponto de restauração e material.
// 2. O agente roda numa pasta temporária vazia, com ambiente mínimo e uma configuração de MCP temporária que aponta só
//    para `cabecao mcp --brain <cérebro> --consolidation <id>`: o servidor trata o agente como agente (todas as
//    restrições do núcleo), prende toda escrita à sessão da consolidação e recusa sync, undo, handoff_save, ingest,
//    consolidate start e, sem `--allow-forget`, forget.
// 3. Quando o agente sai, a CLI confere no git se a consolidação foi fechada. Se foi: o resumo e como desfazer. Se NÃO
//    foi (erro, tempo limite, interrupção, o agente saiu sem `finish`): o que o agente gravou é desfeito com
//    `undo --session <id>` (commits de revert, que um `undo --op` refaz), e a saída diz isso, com código 1. Fechar
//    a metade num commit deixaria no cérebro uma fusão pela metade (a nota nova sem a sobra arquivada, por exemplo)
//    sem ninguém ter olhado; desfazer é o caminho reversível. O ponto de restauração fica de qualquer jeito.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ConsolidateOutput, ConsolidationState, UndoOutput } from '@cabecao/core';
import { consolidateRunRoutine } from '@cabecao/core';
import { readMachine, resolveBrain, withBrain } from '../brain.ts';
import { CliError, UsageError } from '../errors.ts';
import { findExecutable } from '../install-client/files.ts';
import type { CommandContext, CommandResult, Env } from '../types.ts';
import type { AgentAdapter, AgentReport, Invocation, ServerLaunch } from './agents.ts';
import { isRunAgentId, RUN_AGENT_IDS, RUN_AGENTS, UNSUPPORTED_AGENTS } from './agents.ts';
import type { AgentProcessOptions, AgentProcessResult } from './process.ts';
import { runAgentProcess } from './process.ts';

export const DEFAULT_TIMEOUT_MINUTES = 20;
export const MAX_TIMEOUT_MINUTES = 240;

/** Variáveis do ambiente que o agente recebe: sistema, pastas, rede (proxy e certificados), git e Cabeção. */
const BASE_ENV = [
  'PATH',
  'Path',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'ComSpec',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'USERNAME',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;

/** O que o servidor do Cabeção precisa para achar o cérebro, a configuração da máquina e o git. */
const SERVER_ENV = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'CABECAO_CONFIG_DIR',
  'CABECAO_CACHE_DIR',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const;

function pick(env: Env, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== '') out[name] = value;
  }
  return out;
}

/** Ambiente mínimo do agente: o de base, o do login dele e o que o adaptador acrescenta. Nada mais é repassado. */
export function agentEnv(env: Env, adapter: AgentAdapter, extra: Readonly<Record<string, string>>): Env {
  return { ...pick(env, [...BASE_ENV, ...adapter.loginEnv]), ...extra };
}

export function serverEnv(env: Env): Record<string, string> {
  return pick(env, SERVER_ENV);
}

/** Como o agente inicia o servidor: o mesmo Node e o mesmo arquivo do `cabecao` que está rodando agora. */
export async function serverLaunch(
  ctx: Pick<CommandContext, 'execPath' | 'binPath' | 'platform' | 'env'>,
  brain: string,
  consolidationId: string,
  allowForget: boolean,
): Promise<ServerLaunch> {
  const mcpArgs = [
    'mcp',
    '--brain',
    brain,
    '--consolidation',
    consolidationId,
    ...(allowForget ? ['--allow-forget'] : []),
  ];
  const env = serverEnv(ctx.env);
  if (ctx.binPath !== undefined && ctx.binPath !== '') {
    let bin = ctx.binPath;
    try {
      bin = await realpath(bin);
    } catch {
      // fica o caminho como veio
    }
    return { command: ctx.execPath, args: [bin, ...mcpArgs], env };
  }
  const npx = ['npx', '-y', 'cabecao', ...mcpArgs];
  if (ctx.platform === 'win32') return { command: 'cmd', args: ['/c', ...npx], env };
  return { command: 'npx', args: npx.slice(1), env };
}

export interface ChosenAgent {
  readonly adapter: AgentAdapter;
  /** Caminho do executável, ou `null` se não foi achado (só no `--dry-run`). */
  readonly path: string | null;
  readonly source: 'flag' | 'config' | 'auto';
}

function unsupported(name: string): CliError {
  return new CliError(`o agente "${name}" não tem --run: ${UNSUPPORTED_AGENTS[name] ?? ''}`, {
    code: 'EAGENT_UNSUPPORTED',
    hint: `Agentes com --run: ${RUN_AGENT_IDS.join(', ')}.`,
  });
}

async function locate(ctx: Pick<CommandContext, 'env' | 'platform'>, adapter: AgentAdapter): Promise<string | null> {
  const found = await findExecutable(adapter.binary, ctx);
  if (found === undefined) return null;
  // um `.cmd`/`.bat` no Windows só roda por shell, e o roteiro e o JSON nos argumentos não passam por um com segurança
  if (ctx.platform === 'win32' && /\.(?:cmd|bat)$/i.test(found)) {
    throw new CliError(`${found} é um script .cmd: o Cabeção não roda o agente por shell`, {
      code: 'EAGENT_SHELL',
      hint: `Instale a versão nativa (.exe) do ${adapter.label}.`,
    });
  }
  return found;
}

/**
 * O agente: o de `--agent`; senão o da configuração da máquina (`"agent"` no config.json); senão o primeiro instalado na
 * ordem de `RUN_AGENT_IDS` (claude-code, codex, antigravity).
 */
export async function chooseAgent(
  ctx: Pick<CommandContext, 'env' | 'platform' | 'homedir'>,
  requested: string | undefined,
  dryRun: boolean,
): Promise<ChosenAgent> {
  const resolveNamed = async (name: string, source: 'flag' | 'config'): Promise<ChosenAgent> => {
    if (!isRunAgentId(name)) {
      if (name in UNSUPPORTED_AGENTS) throw unsupported(name);
      const message = `agente desconhecido: ${name}. Os agentes com --run são: ${RUN_AGENT_IDS.join(', ')}`;
      if (source === 'flag') throw new UsageError(message);
      throw new CliError(`${message} (veio de "agent" na configuração da máquina)`, { code: 'EAGENT_UNKNOWN' });
    }
    const adapter = RUN_AGENTS[name];
    const path = await locate(ctx, adapter);
    if (path === null && !dryRun) {
      throw new CliError(`o ${adapter.label} (comando "${adapter.binary}") não está instalado nesta máquina`, {
        code: 'EAGENT_MISSING',
        hint: `Instale e faça login no ${adapter.label}, ou escolha outro com --agent (${RUN_AGENT_IDS.join(', ')}).`,
      });
    }
    return { adapter, path, source };
  };
  if (requested !== undefined) return resolveNamed(requested, 'flag');
  const configured = (await readMachine(ctx))?.agent;
  if (configured !== undefined) return resolveNamed(configured, 'config');
  for (const id of RUN_AGENT_IDS) {
    const adapter = RUN_AGENTS[id];
    const path = await locate(ctx, adapter);
    if (path !== null) return { adapter, path, source: 'auto' };
  }
  throw new CliError('nenhum agente com --run instalado nesta máquina', {
    code: 'EAGENT_MISSING',
    hint: `Instale e faça login num destes: ${RUN_AGENT_IDS.map((id) => `${RUN_AGENTS[id].label} (${RUN_AGENTS[id].binary})`).join(', ')}.`,
  });
}

/** O material do `start`, enxuto, para ir no roteiro como dado. */
export function materialJson(output: ConsolidateOutput): string {
  const material = output.material;
  if (material === null) return '{}';
  const note = (n: { id: string; path: string; title: string | null; type: string | null }) => ({
    id: n.id,
    path: n.path,
    title: n.title,
    type: n.type,
  });
  const compact = {
    repeated_episodes: material.repeated_episodes.map((group) => ({
      notes: group.notes.map(note),
      terms: group.terms,
    })),
    duplicates: material.duplicates.map((pair) => ({
      a: note(pair.a),
      b: note(pair.b),
      verdict: pair.verdict,
      reason: pair.reason,
    })),
    lint: material.lint.map((finding) => ({
      rule: finding.rule,
      severity: finding.severity,
      path: finding.path,
      message: finding.message,
      fix: finding.fix,
    })),
  };
  return JSON.stringify(compact, null, 1);
}

export interface RunDeps {
  /** Escolha do agente (nos testes, sem procurar no `PATH`). */
  readonly choose?: (requested: string | undefined, dryRun: boolean) => Promise<ChosenAgent>;
  readonly spawn?: (file: string, args: readonly string[], options: AgentProcessOptions) => Promise<AgentProcessResult>;
  /** Tolerância entre SIGTERM e SIGKILL (testes). */
  readonly graceMs?: number;
}

export interface RunOptions {
  readonly agent: string | undefined;
  readonly scope: string | undefined;
  readonly timeoutMs: number;
  readonly dryRun: boolean;
  readonly model: string | undefined;
  readonly allowForget: boolean;
}

const SOURCE_TEXT: Readonly<Record<ChosenAgent['source'], string>> = {
  flag: 'escolhido com --agent',
  config: 'configurado em "agent" no config.json da máquina',
  auto: `o primeiro instalado na ordem ${RUN_AGENT_IDS.join(', ')}`,
};

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_\-./:=@*]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function minutes(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m === 0 ? `${s} s` : `${m} min ${s} s`;
}

function placeholderPrompt(adapter: AgentAdapter, options: RunOptions): string {
  return consolidateRunRoutine({
    consolidationId: '<consolidation_id>',
    restoreTag: 'cabecao/restore/<data>-<consolidation_id>',
    serverName: adapter.serverName,
    toolExample: adapter.toolExample,
    allowForget: options.allowForget,
    scope: options.scope,
    materialJson: '<material do consolidate start>',
  });
}

async function dryRun(
  ctx: CommandContext,
  brain: string,
  chosen: ChosenAgent,
  options: RunOptions,
): Promise<CommandResult> {
  const { adapter } = chosen;
  const workDir = '<pasta temporária>';
  const server = await serverLaunch(ctx, brain, '<consolidation_id>', options.allowForget);
  const invocation = adapter.prepare({
    workDir,
    server,
    prompt: placeholderPrompt(adapter, options),
    model: options.model,
    timeoutMs: options.timeoutMs,
  });
  const file = chosen.path ?? adapter.binary;
  const env = agentEnv(ctx.env, adapter, invocation.env);
  const lines = [
    `Agente: ${adapter.label} (${chosen.path ?? `"${adapter.binary}" não encontrado no PATH`}; ${SOURCE_TEXT[chosen.source]}).`,
    'Simulação (--dry-run): nada foi executado, nenhum ponto de restauração foi criado.',
    '',
    `Diretório de trabalho: ${workDir} (vazia, apagada no fim)`,
    `Tempo limite: ${minutes(options.timeoutMs)}`,
    `Comando: ${[file, ...invocation.args].map((arg) => (arg.includes('\n') ? '<roteiro>' : shellQuote(arg))).join(' ')}`,
    invocation.stdin === null ? 'O roteiro vai nos argumentos.' : 'O roteiro vai pela entrada padrão.',
    `Ambiente do agente (só estes nomes): ${Object.keys(env).sort().join(', ')}`,
    '',
    'Restrições:',
    ...adapter.restrictions.map((line) => `  - ${line}`),
    `  - o servidor roda com --consolidation: sync, undo, handoff_save, ingest e consolidate start recusados${options.allowForget ? '' : '; forget também (use --allow-forget para liberar)'}`,
  ];
  for (const file of invocation.files) lines.push('', `# ${workDir}/${file.path}`, file.content.trimEnd());
  lines.push('', '# Roteiro', invocation.stdin ?? placeholderPrompt(adapter, options));
  return {
    data: {
      action: 'run',
      dry_run: true,
      agent: adapter.id,
      agent_source: chosen.source,
      binary: chosen.path,
      cwd: workDir,
      command: [file, ...invocation.args],
      stdin: invocation.stdin !== null,
      env: Object.keys(env).sort(),
      files: invocation.files,
      restrictions: adapter.restrictions,
      timeout_ms: options.timeoutMs,
    },
    text: lines.join('\n'),
  };
}

async function writeFiles(workDir: string, invocation: Invocation): Promise<void> {
  for (const file of invocation.files) {
    const path = join(workDir, ...file.path.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content, { mode: 0o600 });
  }
}

async function removeDir(dir: string): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return true;
    } catch {
      // Windows: um processo que acabou de sair ainda segura um arquivo
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  return false;
}

/** Por que a consolidação não foi fechada, em português. */
function failureReason(result: AgentProcessResult, report: AgentReport, timeoutMs: number): string {
  if (result.spawnError !== null) return `o agente não pôde ser iniciado (${result.spawnError})`;
  if (result.timedOut) return `o agente passou do tempo limite (${minutes(timeoutMs)}) e foi encerrado`;
  if (result.interrupted) return 'a execução foi interrompida (Ctrl+C ou sinal) e o agente foi encerrado';
  if (report.error !== null) return `o agente terminou com erro: ${report.error}`;
  if (result.code !== 0) return `o agente saiu com o código ${result.code ?? result.signal ?? 'desconhecido'}`;
  return 'o agente saiu sem chamar consolidate finish';
}

export async function runConsolidation(
  ctx: CommandContext,
  options: RunOptions,
  deps: RunDeps = {},
): Promise<CommandResult> {
  const brain = await resolveBrain(ctx);
  const chosen = await (deps.choose ?? ((requested, dry) => chooseAgent(ctx, requested, dry)))(
    options.agent,
    options.dryRun,
  );
  if (options.dryRun) return dryRun(ctx, brain, chosen, options);
  const { adapter } = chosen;
  const file = chosen.path ?? adapter.binary;

  // 1. start: ponto de restauração e material
  const started = await withBrain(ctx, brain, (b) =>
    b.consolidate({ action: 'start', ...(options.scope === undefined ? {} : { scope: options.scope }) }),
  );
  const id = started.consolidation_id;
  const tag = started.restore_point.tag;
  ctx.stderr.write(
    `cabecao: ${adapter.label} (${SOURCE_TEXT[chosen.source]}) vai consolidar o cérebro sem ninguém olhando; tempo limite ${minutes(options.timeoutMs)}. Ponto de restauração: ${tag}.\n`,
  );

  // 2. o agente, numa pasta temporária vazia
  const workDir = await realpath(await mkdtemp(join(tmpdir(), 'cabecao-run-')));
  let result: AgentProcessResult;
  let report: AgentReport;
  let cleaned = false;
  try {
    const invocation = adapter.prepare({
      workDir,
      server: await serverLaunch(ctx, brain, id, options.allowForget),
      prompt: consolidateRunRoutine({
        consolidationId: id,
        restoreTag: tag,
        serverName: adapter.serverName,
        toolExample: adapter.toolExample,
        allowForget: options.allowForget,
        scope: options.scope,
        materialJson: materialJson(started),
      }),
      model: options.model,
      timeoutMs: options.timeoutMs,
    });
    await writeFiles(workDir, invocation);
    result = await (deps.spawn ?? runAgentProcess)(file, invocation.args, {
      cwd: workDir,
      env: agentEnv(ctx.env, adapter, invocation.env),
      stdin: invocation.stdin,
      timeoutMs: options.timeoutMs,
      platform: ctx.platform,
      ...(deps.graceMs === undefined ? {} : { graceMs: deps.graceMs }),
    });
    report = adapter.parse(result);
  } finally {
    cleaned = await removeDir(workDir);
  }
  if (!cleaned) ctx.stderr.write(`cabecao: aviso: não consegui apagar a pasta temporária ${workDir}\n`);

  // 3. conferir no git
  const state: ConsolidationState = await withBrain(ctx, brain, (b) => b.consolidationState(id));
  const agentData = {
    code: result.code,
    signal: result.signal,
    timed_out: result.timedOut,
    interrupted: result.interrupted,
    duration_ms: result.durationMs,
    summary: report.summary,
    cost_usd: report.costUsd,
    turns: report.turns,
    error: report.error,
  };
  const head = [
    `Agente: ${adapter.label} (${SOURCE_TEXT[chosen.source]}), ${minutes(result.durationMs)}${report.turns === null ? '' : `, ${report.turns} turno(s)`}${report.costUsd === null ? '' : `, US$ ${report.costUsd.toFixed(4)}`}.`,
  ];

  if (state.finish_commit !== null) {
    const lines = [
      ...head,
      `Consolidação ${id} fechada no commit ${state.finish_commit.slice(0, 10)}${state.changes.length === 0 ? ' (nada mudou)' : ':'}`,
      ...state.changes.map((line) => `  - ${line}`),
      '',
      `Para desfazer: cabecao undo --session ${id}`,
      `Ponto de restauração: ${tag} (git reset --hard ${tag} volta a ele, descartando o que veio depois).`,
    ];
    if (report.error !== null) lines.push(`Aviso: o agente relatou um erro depois de fechar: ${report.error}`);
    return {
      code: 0,
      data: {
        action: 'run',
        outcome: 'finished',
        agent: adapter.id,
        agent_source: chosen.source,
        consolidation_id: id,
        restore_point: started.restore_point,
        finish_commit: state.finish_commit,
        changes: state.changes,
        undo: null,
        agent_run: agentData,
        temp_dir_removed: cleaned,
      },
      text: lines.join('\n'),
    };
  }

  // não foi fechada: o que o agente gravou é desfeito
  const reason = failureReason(result, report, options.timeoutMs);
  let undo: UndoOutput | null = null;
  let undoError: string | null = null;
  if (state.session_commits > 0) {
    try {
      undo = await withBrain(ctx, brain, (b) => b.undo({ session: id }));
    } catch (error) {
      undoError = error instanceof Error ? error.message : String(error);
    }
  }
  const lines = [...head, `A consolidação ${id} NÃO foi fechada: ${reason}.`];
  if (state.session_commits === 0) {
    lines.push('O agente não gravou nada; o cérebro está como antes.');
  } else if (undo !== null) {
    lines.push(
      `O que ele tinha gravado foi desfeito, com um commit de revert (${(undo.commit ?? '').slice(0, 10)}):`,
      ...state.changes.map((line) => `  - ${line}`),
      `Para refazer o que ele tinha feito: cabecao undo --op ${undo.op}`,
    );
  } else {
    lines.push(
      `O que ele gravou NÃO pôde ser desfeito sozinho: ${undoError ?? 'erro desconhecido'}.`,
      ...state.changes.map((line) => `  - ${line}`),
      `Desfaça com: cabecao undo --session ${id}`,
    );
  }
  lines.push(`Ponto de restauração: ${tag}.`);
  if (report.summary !== null) lines.push('', 'Última mensagem do agente:', report.summary);
  if (report.error !== null && result.stderr.trim() !== '' && ctx.env.CABECAO_DEBUG === '1') {
    lines.push('', 'stderr do agente:', result.stderr.trim().slice(-4000));
  }
  return {
    code: 1,
    data: {
      action: 'run',
      outcome: 'incomplete',
      reason,
      agent: adapter.id,
      agent_source: chosen.source,
      consolidation_id: id,
      restore_point: started.restore_point,
      finish_commit: null,
      changes: state.changes,
      undo: undo === null ? null : { op: undo.op, commit: undo.commit },
      undo_error: undoError,
      agent_run: agentData,
      temp_dir_removed: cleaned,
    },
    text: lines.join('\n'),
  };
}
