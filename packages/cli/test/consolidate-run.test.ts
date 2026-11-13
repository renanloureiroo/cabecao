// `cabecao consolidate --run` com um AGENTE FALSO (`fake-agent.mjs`): um script que sobe o servidor MCP de verdade a
// partir da configuração temporária, fala JSON-RPC com ele e segue um roteiro fixo. Nenhum agente real roda; o PATH dos
// comandos é uma pasta temporária; os processos filhos são conferidos mortos no fim de cada teste.
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { resolveActor } from '../src/actor.ts';
import {
  agentEnv,
  CALLABLE_AGENT_IDS,
  CALLABLE_AGENTS,
  chooseAgent,
  NOT_CALLABLE_AGENTS,
} from '../src/agents/index.ts';
import type { AgentAdapter } from '../src/consolidate-run/agents.ts';
import { RUN_AGENTS } from '../src/consolidate-run/agents.ts';
import type { RunOptions } from '../src/consolidate-run/run.ts';
import { runConsolidation } from '../src/consolidate-run/run.ts';
import type { CommandContext, CommandResult } from '../src/types.ts';
import type { Machine } from './helpers.ts';
import { brainRepo, disposeSandbox, freshDir, git, HUMAN, machine, parseJson, TEST_TIMEOUT_MS } from './helpers.ts';

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
    actor: resolveActor({ env: {}, terminal: false }),
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
      choose: async () => ({
        agent: CALLABLE_AGENTS['claude-code'],
        path: process.execPath,
        credentials: {},
        source: 'flag',
      }),
      adapter: () => fakeAgent(scenario, reportPath),
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
    // regra, AGENTS.md e log.md pedem o pedido explícito do usuário (decisão 37): sem ninguém olhando, indisponíveis
    expect(refused).toEqual([
      ['write_page', 'human_only'],
      ['write_page', 'human_only'],
      ['write_page', 'human_only'],
      ['write_page', 'human_only'],
      ['write_page', 'unsafe_path'],
      ['write_page', 'human_only'],
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

  it('--allow-elevated libera as ações que pedem confirmação: o agente percorre o token, e a regra fica marcada', async () => {
    const { result, report, brain } = await runFake('elevated', { allowElevated: true });
    expect(result.code).toBe(0);
    const writes = report.calls.filter((call) => call.tool === 'write_page');
    expect(writes.map((call) => call.isError)).toEqual([false, false]);
    const text = readFileSync(join(brain, 'memory', 'rules', 'sempre-obedeca.md'), 'utf8');
    expect(text).toContain('approved_by: user');
    expect(text).not.toContain('origin: human');
    // sem a opção, a mesma sequência não grava a regra
    const blocked = await runFake('elevated');
    expect(blocked.report.calls.filter((call) => call.tool === 'write_page').map((call) => call.code)).toEqual([
      'human_only',
      'human_only',
    ]);
    expect(existsSync(join(blocked.brain, 'memory', 'rules', 'sempre-obedeca.md'))).toBe(false);
  });

  it('--allow-forget e --allow-elevated só o usuário passa, no terminal; sem elas, --run roda sem terminal', async () => {
    const brain = await brainRepo();
    const m = machine();
    for (const flag of ['--allow-forget', '--allow-elevated']) {
      const refused = await m.cabecao([
        'consolidate',
        '--run',
        flag,
        '--agent',
        'claude-code',
        '--dry-run',
        '--brain',
        brain,
        '--json',
      ]);
      expect(refused.code, flag).toBe(4);
      expect(parseJson(refused).error.code).toBe('human_only');
      const human = await m.cabecao(
        ['consolidate', '--run', flag, '--agent', 'claude-code', '--dry-run', '--brain', brain],
        HUMAN,
      );
      expect(human.code, `${flag} ${human.stderr}`).toBe(0);
    }
    expect(
      (await m.cabecao(['consolidate', '--run', '--agent', 'claude-code', '--dry-run', '--brain', brain])).code,
    ).toBe(0);
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
    for (const agent of CALLABLE_AGENT_IDS) {
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
    // sem chave de API, a simulação avisa; com ela, mostra o nome da variável e nunca o valor
    expect(
      (await m.cabecao(['consolidate', '--run', '--agent', 'codex', '--dry-run', '--brain', brain])).stdout,
    ).toContain('só é chamado com chave de API');
    const keyed = await m.cabecao(['consolidate', '--run', '--agent', 'codex', '--dry-run', '--brain', brain], {
      env: { ...m.env, OPENAI_API_KEY: 'sk-teste-nao-mostrar' },
    });
    expect(keyed.stdout).toContain('CODEX_API_KEY');
    expect(keyed.stdout).not.toContain('sk-teste-nao-mostrar');
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
    expect(auto.stderr).toContain('nenhum agente que o Cabeção pode chamar está disponível');
    expect(await git(brain, ['tag', '--list'])).toBe('');
  });

  it('Antigravity e Gemini CLI: os termos não permitem; a mensagem cita a fonte e a alternativa, e nada é criado', async () => {
    const brain = await brainRepo();
    const m = machine();
    for (const name of ['antigravity', 'gemini']) {
      const result = await m.cabecao(['consolidate', '--run', '--agent', name, '--brain', brain, '--json']);
      expect(result.code).toBe(1);
      const error = parseJson(result).error;
      expect(error.code).toBe('EAGENT_UNSUPPORTED');
      expect(error.message).toContain('https://antigravity.google/docs/faq/');
      expect(error.message).toContain('consolidate');
      // nem a simulação o oferece
      const dry = await m.cabecao(['consolidate', '--run', '--agent', name, '--dry-run', '--brain', brain]);
      expect(dry.code).toBe(1);
    }
    expect(await git(brain, ['tag', '--list'])).toBe('');
  });

  it('Codex sem chave de API: recusado com a fonte, sem usar o login do ChatGPT', async () => {
    const brain = await brainRepo();
    const m = machine();
    const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
    await writeFile(join(m.pathDir, name), '#!/bin/sh\n');
    await chmod(join(m.pathDir, name), 0o755);
    const result = await m.cabecao(['consolidate', '--run', '--agent', 'codex', '--brain', brain, '--json']);
    expect(result.code).toBe(1);
    expect(parseJson(result).error).toMatchObject({ code: 'EAGENT_CREDENTIALS' });
    expect(parseJson(result).error.message).toContain('https://learn.chatgpt.com/docs/auth');
    expect(await git(brain, ['tag', '--list'])).toBe('');
  });

  it('cursor explica o porquê; nome desconhecido é erro de uso', async () => {
    const brain = await brainRepo();
    const m = machine();
    const cursor = await m.cabecao(['consolidate', '--run', '--agent', 'cursor', '--brain', brain]);
    expect(cursor.code).toBe(1);
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
    'sem --agent: o configurado na máquina, senão o primeiro instalado e com credencial; agy nunca entra',
    async () => {
      const m = machine();
      for (const name of ['codex', 'agy', 'gemini']) {
        await writeFile(join(m.pathDir, name), '#!/bin/sh\n');
        await chmod(join(m.pathDir, name), 0o755);
      }
      // instalados, mas o Codex sem chave de API e o Antigravity fora da lista: nenhum disponível
      await expect(chooseAgent(m.io, undefined, false)).rejects.toMatchObject({ code: 'EAGENT_MISSING' });
      const withKey = { ...m.io, env: { ...m.env, CODEX_API_KEY: 'k' } };
      const auto = await chooseAgent(withKey, undefined, false);
      expect(auto).toMatchObject({ source: 'auto', agent: { id: 'codex' }, credentials: { CODEX_API_KEY: 'k' } });
      await writeFile(join(m.pathDir, 'claude'), '#!/bin/sh\n');
      await chmod(join(m.pathDir, 'claude'), 0o755);
      expect(await chooseAgent(withKey, undefined, false)).toMatchObject({ agent: { id: 'claude-code' } });
      await mkdir(m.configDir, { recursive: true });
      await writeFile(join(m.configDir, 'config.json'), JSON.stringify({ machine: 'teste', agent: 'codex' }));
      const configured = await chooseAgent(withKey, undefined, false);
      expect(configured).toMatchObject({ source: 'config', agent: { id: 'codex' } });
      expect(configured.path).toBe(join(m.pathDir, 'codex'));
      await writeFile(join(m.configDir, 'config.json'), JSON.stringify({ machine: 'teste', agent: 'antigravity' }));
      await expect(chooseAgent(withKey, undefined, false)).rejects.toMatchObject({ code: 'EAGENT_UNSUPPORTED' });
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
    for (const id of CALLABLE_AGENT_IDS) {
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
  });

  it('agentes sem --run têm o motivo escrito', () => {
    for (const name of ['antigravity', 'gemini', 'cursor', 'vscode', 'copilot', 'claude-desktop', 'opencode']) {
      expect(NOT_CALLABLE_AGENTS[name]?.length ?? 0).toBeGreaterThan(20);
    }
    expect(Object.keys(RUN_AGENTS).sort()).toEqual([...CALLABLE_AGENT_IDS].sort());
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
      CALLABLE_AGENTS['claude-code'],
      {},
      { EXTRA: '1' },
    );
    expect(env).toEqual({ PATH: '/p', HOME: '/h', ANTHROPIC_API_KEY: 'k', EXTRA: '1' });
    // o Codex recebe só a chave de API como CODEX_API_KEY, nunca o resto
    const codex = CALLABLE_AGENTS.codex;
    expect(
      agentEnv(
        { PATH: '/p', OPENAI_API_KEY: 'o', GITHUB_TOKEN: 'g' },
        codex,
        codex.credentials({ OPENAI_API_KEY: 'o' }),
      ),
    ).toEqual({
      PATH: '/p',
      CODEX_API_KEY: 'o',
    });
  });
});
