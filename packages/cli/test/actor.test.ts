// Quem é humano e quem é agente na CLI (`actor.ts`) e a classificação dos comandos (`access.ts`): a regra é pura e
// testável, e nada que o agente controle (argv, ambiente, configuração) eleva para humano.
import { resolveClientName } from '@cabecao/server';
import { describe, expect, it } from 'vitest';
import { accessOf, COMMAND_ACCESS } from '../src/access.ts';
import { AGENT_SIGNALS, FALLBACK_AGENT_CLIENT, resolveActor, sanitizeAgentName } from '../src/actor.ts';
import { COMMANDS } from '../src/commands.ts';

describe('resolveActor', () => {
  it('humano só com terminal controlador e nenhum sinal de agente', () => {
    expect(resolveActor({ env: {}, terminal: true })).toMatchObject({
      actor: 'human',
      client: 'cli',
      reason: 'terminal',
    });
    expect(resolveActor({ env: {}, terminal: false })).toMatchObject({
      actor: 'agent',
      client: FALLBACK_AGENT_CLIENT,
      reason: 'no-terminal',
    });
  });

  it('cada sinal de ambiente de agente faz agente, mesmo com terminal, e dá o nome', () => {
    const expected: Record<string, string> = {
      CLAUDECODE: 'claude-code',
      CLAUDE_CODE_ENTRYPOINT: 'claude-code',
      CODEX_SANDBOX: 'codex',
      CODEX_SANDBOX_NETWORK_DISABLED: 'codex',
      CODEX_THREAD_ID: 'codex',
      CODEX_CI: 'codex',
      GEMINI_CLI: 'gemini-cli',
      CURSOR_AGENT: 'cursor',
      OPENCODE: 'opencode',
      AI_AGENT: 'claude-code',
    };
    for (const signal of AGENT_SIGNALS) {
      const value = signal.variable === 'AI_AGENT' ? 'claude-code_2-1-322_agent' : '1';
      const actor = resolveActor({ env: { [signal.variable]: value }, terminal: true });
      expect(actor, signal.variable).toMatchObject({
        actor: 'agent',
        reason: 'env',
        client: expected[signal.variable],
      });
      expect(signal.source.length, signal.variable).toBeGreaterThan(10);
    }
    // vazia não conta
    expect(resolveActor({ env: { CLAUDECODE: '' }, terminal: true }).actor).toBe('human');
  });

  it('CI ligado é agente; CI=false não muda nada', () => {
    for (const value of ['true', '1', 'yes']) {
      expect(resolveActor({ env: { CI: value }, terminal: true }), value).toMatchObject({
        actor: 'agent',
        client: 'ci',
      });
    }
    expect(resolveActor({ env: { CI: 'false' }, terminal: true }).actor).toBe('human');
  });

  it('nenhuma opção ou variável eleva para humano: --as só nomeia o agente', () => {
    for (const as of ['cli', 'human', 'manual', 'Humano', 'user', '  ', 'CLI', '../../etc', 'x'.repeat(200)]) {
      const actor = resolveActor({ env: {}, terminal: true, as });
      expect(actor.actor, as).toBe('agent');
      expect(['cli', 'manual', 'human', 'user']).not.toContain(actor.client);
    }
    expect(resolveActor({ env: {}, terminal: true, as: 'Claude Code' }).client).toBe('claude-code');
    expect(resolveActor({ env: {}, terminal: true, as: 'meu agente!' }).client).toBe('meu-agente');
    // variáveis que alguém poderia imaginar como "porta dos fundos": nenhuma existe
    for (const env of [
      { CABECAO_ACTOR: 'human' },
      { CABECAO_HUMAN: '1' },
      { CABECAO_AS: 'cli' },
      { HUMAN: '1' },
      { TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal' },
      { SSH_TTY: '/dev/ttys001' },
    ]) {
      expect(resolveActor({ env, terminal: false }).actor, JSON.stringify(env)).toBe('agent');
    }
  });

  it('o nome do agente é saneado como o servidor MCP faz com o clientInfo (e os reservados nunca passam)', () => {
    for (const name of [
      'claude-code',
      'Claude Code',
      'codex-mcp-client',
      'Cursor',
      'gemini-cli',
      'zed',
      'x y',
      '',
      'ñandu',
    ]) {
      const fromServer = resolveClientName(name);
      expect(sanitizeAgentName(name), name).toBe(fromServer === 'mcp' ? FALLBACK_AGENT_CLIENT : fromServer);
    }
    for (const reserved of ['cli', 'manual', 'human']) expect(sanitizeAgentName(reserved)).toBe(FALLBACK_AGENT_CLIENT);
  });
});

describe('classificação dos comandos (access.ts)', () => {
  it('todo comando registrado tem classe, e toda classe é de um comando registrado', () => {
    const names = COMMANDS.map((command) => command.name).sort();
    // se este teste falhou, acrescente o comando novo em access.ts (memória, administração ou só do humano)
    expect(Object.keys(COMMAND_ACCESS).sort()).toEqual(names);
    for (const [name, spec] of Object.entries(COMMAND_ACCESS)) {
      expect(['memory', 'admin', 'human'], name).toContain(spec.access);
      expect(spec.why.length, name).toBeGreaterThan(3);
    }
  });

  it('subcomando com classe própria', () => {
    expect(accessOf('embeddings', ['on'])).toBe('human');
    expect(accessOf('embeddings', ['status'])).toBe('admin');
    expect(accessOf('compact', [])).toBe('human');
    expect(accessOf('sync', [])).toBe('admin');
    expect(accessOf('remember', [])).toBe('memory');
    expect(accessOf('nao-existe', [])).toBeNull();
  });
});
