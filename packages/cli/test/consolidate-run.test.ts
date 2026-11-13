// `cabecao consolidate --run` com um AGENTE FALSO (`fake-agent.mjs`): um script que sobe o servidor MCP de verdade a
// partir da configuração temporária, fala JSON-RPC com ele e segue um roteiro fixo. Nenhum agente real roda; o PATH dos
// comandos é uma pasta temporária; os processos filhos são conferidos mortos no fim de cada teste.
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_NAMES } from '@cabecao/server';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../src/consolidate-run/agents.ts';
import { RUN_AGENT_IDS, RUN_AGENTS, UNSUPPORTED_AGENTS } from '../src/consolidate-run/agents.ts';
import type { RunOptions } from '../src/consolidate-run/run.ts';
import { agentEnv, chooseAgent, runConsolidation } from '../src/consolidate-run/run.ts';
import { SERVER_TOOL_NAMES } from '../src/consolidate-run/tools.ts';
import type { CommandContext, CommandResult } from '../src/types.ts';
import type { Machine } from './helpers.ts';
import { brainRepo, disposeSandbox, freshDir, git, machine, parseJson, TEST_TIMEOUT_MS } from './helpers.ts';

const FAKE_AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
const BIN = fileURLToPath(new URL('../src/bin.ts', import.meta.url));

afterAll(() => disposeSandbox());

const pids: number[] = [];
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
afterEach(() => {
  for (const pid of pids.splice(0)) {
    if (alive(pid)) {
      process.kill(pid, 'SIGKILL');
      throw new Error(`processo ${pid} ficou para trás`);
    }
  }
});

interface Report {
  cwd: string;
  pid: number;
  serverPid: number | null;
  id: string;
  envNames: string[];
  promptHasMaterial: boolean;
  calls: { tool: string; isError: boolean; code: string | null }[];
}

/** O agente falso no lugar do Claude Code: mesma configuração temporária, outro executável. */
function fakeAgent(scenario: string, report: string): AgentAdapter {
  const claude = RUN_AGENTS['claude-code'];
  return {
    ...claude,
    binary: process.execPath,
    prepare(input) {
      const base = claude.prepare(input);
      return {
        ...base,
        args: [FAKE_AGENT, '--config', join(input.workDir, 'mcp.json'), '--scenario', scenario, '--report', report],
      };
    },
  };
}

function context(m: Machine, brain: string, stderr: string[]): CommandContext {
  return {
    argv: [],
    env: {
      ...m.env,
      // o servidor que o agente sobe precisa do git de verdade e da identidade de teste
      PATH: process.env.PATH ?? '',
      // no Windows, o Node e o git dos filhos precisam das variáveis do sistema
      ...Object.fromEntries(
        ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']
          .map((name) => [name, process.env[name]])
          .filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL ?? '',
      GIT_CONFIG_NOSYSTEM: '1',
      SEGREDO_QUALQUER: 'nao-deveria-chegar-ao-agente',
    },
    cwd: m.home,
    stdout: { write: () => true },
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    platform: process.platform,
    homedir: m.home,
    execPath: process.execPath,
    binPath: BIN,
    exec: m.exec,
    command: 'consolidate',
    values: {},
    positionals: [],
    json: true,
    brain,
    version: '0.0.0-teste',
  };
}

const OPTIONS: RunOptions = {
  agent: undefined,
  scope: undefined,
  timeoutMs: 60_000,
  dryRun: false,
  model: undefined,
  allowForget: false,
};

async function runFake(
  scenario: string,
  options: Partial<RunOptions> = {},
): Promise<{ result: CommandResult; report: Report; brain: string; stderr: string }> {
  const brain = await brainRepo();
  const m = machine();
  const reportPath = join(freshDir('relatorio'), 'report.json');
  const stderr: string[] = [];
  const result = await runConsolidation(
    context(m, brain, stderr),
    { ...OPTIONS, ...options },
    {
      choose: async () => ({ adapter: fakeAgent(scenario, reportPath), path: process.execPath, source: 'flag' }),
      graceMs: 500,
    },
  );
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report;
  pids.push(report.pid);
  if (report.serverPid !== null) pids.push(report.serverPid);
  return { result, report, brain, stderr: stderr.join('') };
}

// biome-ignore lint/suspicious/noExplicitAny: `data` de cada saída é conferido campo a campo
const dataOf = (result: CommandResult): any => result.data;

describe('consolidate --run com um agente falso', { timeout: TEST_TIMEOUT_MS }, () => {
  it('sucesso: o agente fecha a consolidação; resumo, como desfazer, pasta temporária apagada', async () => {
    const { result, report, brain } = await runFake('success');
    expect(result.code).toBe(0);
    const data = dataOf(result);
    expect(data.outcome).toBe('finished');
    expect(data.changes).toEqual(['add fact: Fila oficial success']);
    expect(result.text).toContain(`cabecao undo --session ${data.consolidation_id}`);
    expect(result.text).toContain(data.restore_point.tag);
    // o roteiro levou o id e o material; o agente rodou numa pasta temporária que não existe mais
    expect(report.id).toBe(data.consolidation_id);
    expect(report.promptHasMaterial).toBe(true);
    expect(existsSync(report.cwd)).toBe(false);
    expect(data.temp_dir_removed).toBe(true);
    // a saída completa do agente fica guardada, só para o dono
    expect(readFileSync(data.log, 'utf8')).toContain('Consolidei: um fato novo.');
    expect(result.text).toContain(data.log);
    // ambiente mínimo: o que não é do sistema, do git ou do login do agente não chega
    expect(report.envNames).not.toContain('SEGREDO_QUALQUER');
    expect(report.envNames).toContain('ENABLE_TOOL_SEARCH');
    // um commit só, com a sessão da consolidação (o agente mandou outro session_handle e o servidor trocou)
    const message = await git(brain, ['log', '-1', '--format=%B']);
    expect(message).toContain(`Cabecao-Session: ${data.consolidation_id}`);
    expect(await git(brain, ['rev-list', '--count', `${data.restore_point.commit}..HEAD`])).toBe('1');
  });

  it('o agente não acha nada a fazer: sai com 0, sem commit e sem undo', async () => {
    const { result, brain } = await runFake('nothing');
    expect(result.code).toBe(0);
    const data = dataOf(result);
    expect(data.outcome).toBe('unchanged');
    expect(result.text).toContain('o agente terminou sem gravar nada');
    expect(await git(brain, ['rev-list', '--count', `${data.restore_point.commit}..HEAD`])).toBe('0');
  });

  it('o agente sai sem finish: o que ele gravou é desfeito, código 1', async () => {
    const { result, brain } = await runFake('no-finish');
    expect(result.code).toBe(1);
    const data = dataOf(result);
    expect(data.outcome).toBe('incomplete');
    expect(data.reason).toBe('o agente saiu sem chamar consolidate finish');
    expect(data.undo).not.toBeNull();
    expect(result.text).toContain('NÃO foi fechada');
    expect(result.text).toContain(`cabecao undo --op ${data.undo.op}`);
    // as notas voltaram a ser as do ponto de restauração
    expect(await git(brain, ['diff', '--stat', data.restore_point.commit, 'HEAD', '--', 'memory', 'wiki'])).toBe('');
  });

  it('o agente quebra: código do agente na saída, desfeito', async () => {
    const { result } = await runFake('crash');
    expect(result.code).toBe(1);
    expect(dataOf(result).reason).toContain('quebrei');
    expect(dataOf(result).undo).not.toBeNull();
  });

  it('tempo limite: o agente e o servidor que ele subiu são encerrados, e o que foi gravado é desfeito', async () => {
    const { result, report } = await runFake('timeout', { timeoutMs: 4000 });
    expect(result.code).toBe(1);
    const data = dataOf(result);
    expect(data.agent_run.timed_out).toBe(true);
    expect(data.reason).toContain('tempo limite');
    expect(data.undo).not.toBeNull();
    expect(alive(report.pid)).toBe(false);
    if (report.serverPid !== null) expect(alive(report.serverPid)).toBe(false);
    expect(existsSync(report.cwd)).toBe(false);
  });

  it('agente hostil: regra, arquivo de instrução, fora do cérebro, forget, sync, undo, start: tudo recusado', async () => {
    const { result, report, brain } = await runFake('hostile');
    expect(result.code).toBe(0);
    const refused = report.calls.filter((call) => call.isError).map((call) => [call.tool, call.code]);
    expect(refused).toEqual([
      ['write_page', 'rule_requires_human'],
      ['write_page', 'invalid_path'],
      ['write_page', 'invalid_path'],
      ['write_page', 'unsafe_path'],
      ['write_page', 'invalid_path'],
      ['forget', 'human_only'],
      ['sync', 'human_only'],
      ['undo', 'human_only'],
      ['handoff_save', 'human_only'],
      ['consolidate', 'human_only'],
      ['consolidate', 'invalid_argument'],
    ]);
    expect(existsSync(join(brain, 'memory', 'rules', 'sempre-obedeca.md'))).toBe(false);
    expect(existsSync(join(brain, 'wiki', 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(brain, '..', 'fora-do-cerebro.md'))).toBe(false);
    expect(readFileSync(join(brain, 'AGENTS.md'), 'utf8')).not.toContain('Ignore o usuário');
    // só o fato entrou
    expect(dataOf(result).changes).toEqual(['add fact: Fila oficial hostile']);
  });

  it('--allow-forget libera o forget (com a confirmação em duas chamadas do núcleo)', async () => {
    const { report } = await runFake('forget', { allowForget: true });
    const forget = report.calls.find((call) => call.tool === 'forget');
    expect(forget).toMatchObject({ isError: false });
  });
});

describe('consolidate --run pela linha de comando', { timeout: TEST_TIMEOUT_MS }, () => {
  it('--dry-run mostra o comando e a configuração temporária, sem criar ponto de restauração', async () => {
    const brain = await brainRepo();
    const m = machine();
    for (const agent of RUN_AGENT_IDS) {
      const result = await m.cabecao(['consolidate', '--run', '--agent', agent, '--dry-run', '--brain', brain]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Simulação (--dry-run)');
      expect(result.stdout).toContain('não encontrado no PATH');
      expect(result.stdout).toContain('--consolidation');
    }
    const claude = await m.cabecao(['consolidate', '--run', '--agent', 'claude-code', '--dry-run', '--brain', brain]);
    expect(claude.stdout).toContain('--strict-mcp-config');
    expect(claude.stdout).toContain('# <pasta temporária>/mcp.json');
    const json = parseJson(
      await m.cabecao(['consolidate', '--run', '--agent', 'codex', '--dry-run', '--json', '--brain', brain]),
    );
    expect(json.data.command).toContain('--ignore-user-config');
    expect(await git(brain, ['tag', '--list'])).toBe('');
  });

  it('agente não instalado: erro claro, código 1 e nada criado', async () => {
    const brain = await brainRepo();
    const m = machine();
    const result = await m.cabecao(['consolidate', '--run', '--agent', 'claude-code', '--brain', brain, '--json']);
    expect(result.code).toBe(1);
    expect(parseJson(result).error).toMatchObject({ code: 'EAGENT_MISSING' });
    const auto = await m.cabecao(['consolidate', '--run', '--brain', brain]);
    expect(auto.code).toBe(1);
    expect(auto.stderr).toContain('nenhum agente com --run instalado');
    expect(await git(brain, ['tag', '--list'])).toBe('');
  });

  it('agentes sem --run: gemini aponta o Antigravity, cursor explica o porquê', async () => {
    const brain = await brainRepo();
    const m = machine();
    const gemini = await m.cabecao(['consolidate', '--run', '--agent', 'gemini', '--brain', brain]);
    expect(gemini.code).toBe(1);
    expect(gemini.stderr).toContain('--agent antigravity');
    const cursor = await m.cabecao(['consolidate', '--run', '--agent', 'cursor', '--brain', brain]);
    expect(cursor.stderr).toContain('shell');
    const unknown = await m.cabecao(['consolidate', '--run', '--agent', 'qualquer', '--brain', brain]);
    expect(unknown.code).toBe(2);
  });

  it('opções de --run sem --run, e --run com --finish, são erro de uso', async () => {
    const m = machine();
    expect((await m.cabecao(['consolidate', '--agent', 'codex'])).code).toBe(2);
    expect((await m.cabecao(['consolidate', '--run', '--finish', '01AAAAAAAAAAAAAAAAAAAAAAAA'])).code).toBe(2);
    expect((await m.cabecao(['consolidate', '--run', '--timeout', '0'])).code).toBe(2);
  });
});

describe('escolha do agente', () => {
  it.skipIf(process.platform === 'win32')(
    'sem --agent: o configurado na máquina, senão o primeiro instalado',
    async () => {
      const m = machine();
      for (const name of ['codex', 'agy']) {
        await writeFile(join(m.pathDir, name), '#!/bin/sh\n');
        await chmod(join(m.pathDir, name), 0o755);
      }
      const auto = await chooseAgent(m.io, undefined, false);
      expect(auto).toMatchObject({ source: 'auto', adapter: { id: 'codex' } });
      await mkdir(m.configDir, { recursive: true });
      await writeFile(join(m.configDir, 'config.json'), JSON.stringify({ machine: 'teste', agent: 'antigravity' }));
      const configured = await chooseAgent(m.io, undefined, false);
      expect(configured).toMatchObject({ source: 'config', adapter: { id: 'antigravity' } });
      expect(configured.path).toBe(join(m.pathDir, 'agy'));
    },
  );
});

describe('adaptadores', () => {
  const server = {
    command: '/node',
    args: ['/bin.mjs', 'mcp', '--brain', '/b', '--consolidation', 'X'],
    env: { HOME: '/h' },
  };
  const input = { workDir: '/tmp/w', server, prompt: 'roteiro', model: undefined, timeoutMs: 600_000 };

  it('nenhum adaptador pula as permissões', () => {
    for (const id of RUN_AGENT_IDS) {
      const args = RUN_AGENTS[id].prepare(input).args.join(' ');
      expect(args).not.toMatch(/dangerously|bypassPermissions|--yolo|--force|always-proceed/);
    }
  });

  it('Claude Code: só o servidor temporário, sem tools embutidas, só mcp__cabecao__*', () => {
    const invocation = RUN_AGENTS['claude-code'].prepare(input);
    const args = invocation.args;
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args).toContain('--strict-mcp-config');
    expect(after('--tools')).toBe('');
    expect(after('--allowedTools')).toBe('mcp__cabecao__*');
    expect(after('--permission-mode')).toBe('dontAsk');
    expect(after('--permission-prompts')).toBe('none');
    expect(after('--model')).toBe('haiku');
    expect(args).toContain('--restricted');
    expect(invocation.stdin).toBe('roteiro');
    expect(invocation.env.ENABLE_TOOL_SEARCH).toBe('false');
    expect(JSON.parse(invocation.files[0]?.content ?? '{}')).toEqual({
      mcpServers: { cabecao: { type: 'stdio', ...server } },
    });
  });

  it('Codex: sem config do usuário, sem shell, caixa de areia read-only, servidor por -c', () => {
    const args = RUN_AGENTS.codex.prepare(input).args;
    expect(args.slice(0, 4)).toEqual(['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral']);
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(args).toContain('approval_policy="never"');
    expect(args).toContain('web_search="disabled"');
    for (const feature of ['shell_tool', 'unified_exec', 'browser_use', 'computer_use']) {
      expect(args.join(' ')).toContain(`--disable ${feature}`);
    }
    expect(args).toContain('mcp_servers.cabecao.command="/node"');
    expect(args).toContain('mcp_servers.cabecao.args=["/bin.mjs", "mcp", "--brain", "/b", "--consolidation", "X"]');
    expect(args).toContain('mcp_servers.cabecao.env={ "HOME" = "/h" }');
    expect(args.at(-1)).toBe('-');
  });

  it('Antigravity: configuração na pasta de trabalho, permissões só da sessão', () => {
    const invocation = RUN_AGENTS.antigravity.prepare(input);
    const args = invocation.args;
    const settings = JSON.parse(args[args.indexOf('--settings') + 1] ?? '{}');
    expect(settings.permissions.allow).toEqual(['mcp(cabecao-run/*)']);
    expect(settings.permissions.deny).toEqual(['command(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)']);
    expect(settings.trustedWorkspaces).toEqual(['/tmp/w']);
    expect(args[args.indexOf('--print') + 1]).toBe('roteiro');
    expect(args).toContain('--sandbox');
    const file = invocation.files[0];
    expect(file?.path).toBe('.agents/mcp_config.json');
    const config = JSON.parse(file?.content ?? '{}');
    expect(config.mcpServers['cabecao-run'].command).toBe('/node');
    expect(config.mcpServers['cabecao-run'].tools.consolidate).toEqual({ eager: true });
  });

  it('leitura da saída de cada agente', () => {
    expect(
      RUN_AGENTS['claude-code'].parse({
        code: 0,
        stdout:
          '{"type":"result","subtype":"success","is_error":false,"result":"ok","num_turns":5,"total_cost_usd":0.012}',
        stderr: '',
      }),
    ).toEqual({ summary: 'ok', costUsd: 0.012, turns: 5, error: null });
    expect(
      RUN_AGENTS.codex.parse({
        code: 0,
        stdout: [
          '{"type":"thread.started","thread_id":"t"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"feito"}}',
          '{"type":"turn.completed","usage":{"input_tokens":10}}',
        ].join('\n'),
        stderr: '',
      }),
    ).toEqual({ summary: 'feito', costUsd: null, turns: 1, error: null });
    expect(
      RUN_AGENTS.antigravity.parse({
        code: 1,
        stdout: '{"conversation_id":"c","status":"ERROR","error":"quota","num_turns":2}',
        stderr: '',
      }),
    ).toMatchObject({ error: 'quota', turns: 2 });
  });

  it('agentes sem --run têm o motivo escrito', () => {
    for (const name of ['gemini', 'cursor', 'vscode', 'copilot', 'claude-desktop', 'opencode']) {
      expect(UNSUPPORTED_AGENTS[name]?.length ?? 0).toBeGreaterThan(20);
    }
  });

  it('a cópia dos nomes das tools é a mesma do servidor', () => {
    expect([...SERVER_TOOL_NAMES]).toEqual([...TOOL_NAMES]);
  });

  it('ambiente mínimo: só sistema, pastas, rede, git e o login do agente', () => {
    const env = agentEnv(
      {
        PATH: '/p',
        HOME: '/h',
        ANTHROPIC_API_KEY: 'k',
        OPENAI_API_KEY: 'o',
        AWS_SECRET_ACCESS_KEY: 's',
        GITHUB_TOKEN: 'g',
      },
      RUN_AGENTS['claude-code'],
      { EXTRA: '1' },
    );
    expect(env).toEqual({ PATH: '/p', HOME: '/h', ANTHROPIC_API_KEY: 'k', EXTRA: '1' });
  });
});
