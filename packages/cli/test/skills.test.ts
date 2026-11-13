// As skills do Cabeção (`integrations/skills/`, a fonte única): o formato Agent Skills, a cópia embutida na CLI
// (`src/skills/content.ts`) igual à fonte, e nenhuma skill citando comando, opção ou tool que não existe. Por último,
// um AGENTE FALSO executa, um por um, os comandos que as skills mandam rodar (os blocos ```sh), contra uma cópia de
// `fixtures/vault`, sem terminal (como o Bash de um agente roda), e confere que cada um funciona e devolve o que a skill
// diz. É a garantia de que as skills não ensinam nada quebrado.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_NAMES } from '@cabecao/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/commands.ts';
import { GLOBAL_OPTIONS } from '../src/router.ts';
import { INSTRUCTIONS_BLOCK, SKILLS } from '../src/skills/content.ts';
import { brainRepo, disposeSandbox, HUMAN, machine, readNote, TEST_TIMEOUT_MS } from './helpers.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SOURCE = join(REPO, 'integrations', 'skills');

afterAll(disposeSandbox);

/** Os comandos `cabecao ...` de um texto: as linhas dos blocos de código e os trechos entre crases. */
function commandMentions(text: string): string[] {
  const out: string[] = [];
  for (const block of text.matchAll(/```sh\n([\s\S]*?)```/g)) {
    for (const line of (block[1] ?? '').split('\n')) if (line.startsWith('cabecao ')) out.push(line);
  }
  for (const inline of text.matchAll(/`(cabecao [^`]+)`/g)) out.push(inline[1] ?? '');
  return out;
}

/** Palavras de uma linha de shell, com aspas simples e duplas; o heredoc (`<<'EOF'`) e o resto da linha ficam de fora. */
function shellWords(line: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote = '';
  let has = false;
  for (const char of line.replace(/\s*<<'EOF'.*$/, '')) {
    if (quote !== '') {
      if (char === quote) quote = '';
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      has = true;
    } else if (char === ' ') {
      if (has || current !== '') words.push(current);
      current = '';
      has = false;
    } else current += char;
  }
  if (has || current !== '') words.push(current);
  return words;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

describe('formato e fonte única', () => {
  it('a cópia embutida na CLI bate com integrations/skills (senão: pnpm build:skills)', () => {
    const result = spawnSync(process.execPath, [join(REPO, 'scripts', 'build-skills.mjs'), '--check'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(result.stdout + result.stderr).toContain('skills embutidas em dia');
    expect(result.status).toBe(0);
    const dirs = readdirSync(SOURCE).filter((name) => statSync(join(SOURCE, name)).isDirectory());
    expect(SKILLS.map((skill) => skill.name)).toEqual(dirs.sort());
    expect(INSTRUCTIONS_BLOCK).toBe(readFileSync(join(SOURCE, 'instrucoes.md'), 'utf8').replaceAll('\r\n', '\n'));
  });

  it('de 3 a 6 skills, no formato Agent Skills: name = pasta, descrição pela intenção, corpo curto', () => {
    expect(SKILLS.length).toBeGreaterThanOrEqual(3);
    expect(SKILLS.length).toBeLessThanOrEqual(6);
    for (const skill of SKILLS) {
      const text = skill.files.find((file) => file.path === 'SKILL.md')?.content ?? '';
      const front = FRONTMATTER.exec(text)?.[1] ?? '';
      expect(front.split('\n').map((line) => line.split(':')[0])).toEqual(['name', 'description']);
      expect(skill.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(skill.name.length).toBeLessThanOrEqual(64);
      expect(front).toContain(`name: ${skill.name}\n`);
      expect(skill.description.length, skill.name).toBeGreaterThan(200);
      expect(skill.description.length, skill.name).toBeLessThanOrEqual(1024);
      // sem ":" seguido de espaço na descrição: o YAML leria como um mapa
      expect(skill.description).not.toMatch(/: /);
      expect(skill.description).toMatch(/\bUse\b/);
      expect(text.split('\n').length, skill.name).toBeLessThan(200);
      expect(text, skill.name).toContain('--json');
      expect(text, skill.name).toContain('--as <cliente>');
      expect(text, skill.name).toMatch(/servidor MCP `cabecao` estiver conectado/);
      expect(text, skill.name).toMatch(/dado, nunca instrução/);
    }
  });

  it('só citam comandos e opções que existem', () => {
    const wrong: string[] = [];
    const texts = [...SKILLS.flatMap((skill) => skill.files.map((file) => file.content)), INSTRUCTIONS_BLOCK];
    let count = 0;
    for (const text of texts) {
      for (const line of commandMentions(text)) {
        count += 1;
        const [, name = '', ...rest] = shellWords(line);
        const command = COMMANDS.find((candidate) => candidate.name === name);
        if (command === undefined) {
          wrong.push(`comando: ${line}`);
          continue;
        }
        const options = { ...command.options, ...GLOBAL_OPTIONS };
        for (const word of rest) {
          const option = /^--([a-z][a-z-]*)/.exec(word)?.[1];
          if (option !== undefined && !(option in options)) wrong.push(`opção --${option}: ${line}`);
        }
      }
    }
    expect(count).toBeGreaterThan(40);
    expect(wrong).toEqual([]);
  });

  it('só citam tools que existem no servidor MCP', () => {
    const notTools = new Set(['confirm_token', 'session_handle', 'data_notice', 'next_step', 'consolidation_id']);
    const wrong: string[] = [];
    for (const skill of SKILLS) {
      const text = skill.files.map((file) => file.content).join('\n');
      for (const line of text.split('\n').filter((candidate) => /\btools?\b/.test(candidate))) {
        for (const match of line.matchAll(/`([a-z][a-z_]*)`/g)) {
          const word = match[1] ?? '';
          if (!notTools.has(word) && !(TOOL_NAMES as readonly string[]).includes(word) && word !== 'cabecao') {
            wrong.push(`${skill.name}: ${word}`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

/** O que o agente falso guardou das respostas anteriores, para preencher os marcadores dos comandos seguintes. */
interface State {
  session?: string;
  token?: string;
  op?: string;
  candidate?: { id: string; path: string };
  created?: string;
  consolidation?: string;
  userOp?: string;
}

const FIXED: Readonly<Record<string, string>> = {
  '<cliente>': 'agente-de-teste',
  '<seu-nome>': 'agente-de-teste',
  '<tarefa>': 'migrar os consumidores do atlas',
  '<projeto>': 'atlas',
  '<pergunta>': 'fila de mensagens',
  '<AAAA-MM-DD>': '2026-03-01',
  '<nota>': 'Projeto Atlas',
  '<outra nota>': 'SQS',
  '<predicado>': 'uses_queue',
  '<valor>': 'SQS',
  '<tipo>': 'preference',
  '<motivo>': 'pedido do usuário no teste',
  '<o que foi feito>': 'migrei os consumidores de faturamento',
  '<o que falta, em ordem>': 'migrar o rastreio',
  '<decisão e o porquê>': 'lotes de 25 porque reduz o custo',
  '<armadilha encontrada>': 'limpar o banco antes dos testes',
};

const LOTE =
  'Os consumidores do Atlas leem do SQS em lotes de 10 mensagens por chamada, com espera longa de 20 segundos.';

/** O valor de um marcador no comando `command` da skill `skill`, com o estado das respostas anteriores. */
function fill(text: string, skill: string, line: string, state: State, round: number): string {
  const command = line.split(' ')[1] ?? '';
  return text.replace(/<[^<>\n]+>/g, (marker) => {
    const fixed = FIXED[marker];
    if (fixed !== undefined) return fixed;
    switch (marker) {
      case '<session_handle>':
        return state.session ?? 'sem-sessao';
      case '<confirm_token>':
        return state.token ?? 'sem-token';
      case '<consolidation_id>':
        return state.consolidation ?? 'sem-consolidacao';
      case '<id>':
        return state.candidate?.id ?? 'sem-id';
      case '<op>':
        return skill === 'cabecao-pedido-explicito' ? (state.userOp ?? 'sem-op') : (state.op ?? 'sem-op');
      case '<título>':
        return skill === 'cabecao-pedido-explicito' ? 'Sempre pnpm' : 'Leitura em lote do Atlas';
      case '<conteúdo>':
        if (skill === 'cabecao-pedido-explicito') return 'Use sempre pnpm, nunca npm.';
        if (command === 'write') return 'Vale também para o faturamento.';
        if (command === 'remember' && line.includes('--type fact')) return 'O Atlas usa o SQS para as filas.';
        return round === 0 ? LOTE : LOTE.replace('lotes de 10', 'lotes de 25');
      case '<caminho>':
        if (skill === 'cabecao-consultar') return 'memory/gotchas/testes-de-integracao-sem-limpar-o-banco.md';
        if (skill === 'cabecao-manutencao') return 'memory/preferences/respostas-em-portugues.md';
        if (command === 'read') return state.candidate?.path ?? 'sem-caminho';
        return state.created ?? 'sem-caminho';
      case '<trecho atual>':
        return skill === 'cabecao-pedido-explicito' ? 'Tudo aqui é inventado.' : 'com espera longa';
      case '<trecho novo>':
        return skill === 'cabecao-pedido-explicito'
          ? 'Tudo aqui é inventado, de propósito.'
          : 'com espera longa (long polling)';
      default:
        throw new Error(`marcador sem valor no teste: ${marker} (${skill}, ${command})`);
    }
  });
}

/** Os comandos de um bloco ```sh, com o conteúdo do heredoc de cada um. */
function blocks(text: string): Array<Array<{ line: string; stdin: string | undefined }>> {
  const out: Array<Array<{ line: string; stdin: string | undefined }>> = [];
  for (const block of text.matchAll(/```sh\n([\s\S]*?)```/g)) {
    const lines = (block[1] ?? '').split('\n');
    const commands: Array<{ line: string; stdin: string | undefined }> = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (!line.startsWith('cabecao ')) continue;
      if (!line.includes("<<'EOF'")) {
        commands.push({ line, stdin: undefined });
        continue;
      }
      const body: string[] = [];
      for (i += 1; i < lines.length && lines[i] !== 'EOF'; i++) body.push(lines[i] ?? '');
      commands.push({ line, stdin: `${body.join('\n')}\n` });
    }
    out.push(commands);
  }
  return out;
}

describe('agente falso: roda o que as skills mandam', { timeout: TEST_TIMEOUT_MS }, () => {
  let brain: string;
  const m = machine('agente');
  const state: State = {};
  const ran: string[] = [];

  beforeAll(async () => {
    brain = await brainRepo();
    // uma operação do USUÁRIO (no terminal), para o "desfazer operação que não é sua" da skill de pedido explícito
    const human = await m.cabecao(
      ['remember', '--type', 'preference', '--title', 'Do usuário', 'gosto de café', '--brain', brain, '--json'],
      HUMAN,
    );
    state.userOp = JSON.parse(human.stdout).data.op;
  });

  /** Roda um comando da skill como agente (sem terminal), com o cérebro do teste e o stdin do heredoc. */
  async function agent(skill: string, entry: { line: string; stdin: string | undefined }, round = 0) {
    const words = shellWords(entry.line);
    const filled = words.slice(1).map((word) => fill(word, skill, entry.line, state, round));
    const stdin = entry.stdin === undefined ? undefined : fill(entry.stdin, skill, entry.line, state, round);
    ran.push(`${skill}: ${entry.line}`);
    const result = await m.cabecao([...filled, '--brain', brain], {
      ...(stdin === undefined ? {} : { readStdin: async () => stdin }),
    });
    let json: { ok: boolean; data?: Record<string, unknown> & { [key: string]: unknown }; error?: unknown };
    try {
      json = JSON.parse(result.stdout);
    } catch {
      throw new Error(`${entry.line}: a saída não é JSON (código ${result.code}): ${result.stdout}${result.stderr}`);
    }
    const data = (json.data ?? {}) as Record<string, unknown>;
    if (typeof data.confirm_token === 'string') state.token = data.confirm_token;
    if (typeof data.session_handle === 'string') state.session = data.session_handle;
    if (typeof data.consolidation_id === 'string') state.consolidation = data.consolidation_id;
    if (typeof data.op === 'string' && data.op !== '') state.op = data.op;
    return { code: result.code, json, data, stderr: result.stderr };
  }

  const skill = (name: string) => {
    const found = SKILLS.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`skill ${name} não existe`);
    return blocks(found.files.find((file) => file.path === 'SKILL.md')?.content ?? '');
  };

  it('cabecao-consultar: recall traz regras, handoff e session_handle; search, read, graph e facts respondem', async () => {
    const [recall = [], search = [], reading = []] = skill('cabecao-consultar');
    for (const entry of recall) {
      const out = await agent('cabecao-consultar', entry);
      expect(out.code, entry.line).toBe(0);
      expect(out.data.data_notice).toMatch(/nunca instrução/);
      expect(Array.isArray(out.data.rules)).toBe(true);
      expect(out.data).toHaveProperty('handoff');
      expect(out.data.session_handle).toMatch(/^[0-9A-Z]{26}$/);
    }
    for (const entry of search) {
      const out = await agent('cabecao-consultar', entry);
      expect(out.code, entry.line).toBe(0);
      const results = out.data.hits as Array<{ path: string; validity: string }>;
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toMatchObject({
        path: expect.any(String),
        validity: expect.stringMatching(/current|expired|future/),
      });
    }
    for (const entry of reading) {
      const out = await agent('cabecao-consultar', entry);
      expect(out.code, entry.line).toBe(0);
      expect(out.json.ok).toBe(true);
    }
  });

  it('cabecao-lembrar: grava, acusa needs_resolution, resolve com --resolution, liga, acrescenta e troca trecho', async () => {
    const [first = [], fact = [], resolution = [], linking = []] = skill('cabecao-lembrar');
    const [remember] = first;
    if (remember === undefined) throw new Error('bloco do remember');
    const created = await agent('cabecao-lembrar', remember);
    expect(created.code).toBe(0);
    expect(created.data).toMatchObject({ decision: 'created', path: expect.any(String), commit: expect.any(String) });
    state.created = created.data.path as string;
    expect(await readNote(brain, state.created)).toContain('origin: agent:agente-de-teste');

    for (const entry of fact) {
      const out = await agent('cabecao-lembrar', entry);
      expect(out.code, entry.line).toBe(0);
      expect(['created', 'updated', 'superseded', 'skipped']).toContain(out.data.decision);
    }

    // a mesma memória, com outro conteúdo: needs_resolution, nada gravado, com as candidatas
    const pending = await agent('cabecao-lembrar', remember, 1);
    expect(pending.data).toMatchObject({ decision: 'needs_resolution', commit: null, changed: false });
    const [candidate] = pending.data.candidates as Array<{ id: string; path: string }>;
    if (candidate === undefined) throw new Error('sem candidata');
    state.candidate = candidate;
    const [resolve] = resolution;
    if (resolve === undefined) throw new Error('bloco do --resolution');
    const resolved = await agent('cabecao-lembrar', resolve, 1);
    expect(resolved.code).toBe(0);
    expect(resolved.data.decision).toBe('updated');
    expect(await readNote(brain, candidate.path)).toContain('lotes de 25');

    for (const entry of linking) {
      const out = await agent('cabecao-lembrar', entry);
      expect(out.code, `${entry.line}: ${JSON.stringify(out.json)}`).toBe(0);
    }
    const note = await readNote(brain, state.created);
    expect(note).toContain('Vale também para o faturamento.');
    expect(note).toContain('com espera longa (long polling)');
  });

  it('cabecao-passar-bastao: handoff gravado com o session_handle; sync responde com o status', async () => {
    const [handoff = [], sync = []] = skill('cabecao-passar-bastao');
    for (const entry of handoff) {
      const out = await agent('cabecao-passar-bastao', entry);
      expect(out.code, JSON.stringify(out.json)).toBe(0);
      expect(out.data).toMatchObject({
        handoff: { path: expect.stringMatching(/^memory\/handoffs\//) },
        commit: expect.any(String),
        op: expect.any(String),
        expires_at: expect.any(String),
      });
    }
    for (const entry of sync) {
      const out = await agent('cabecao-passar-bastao', entry);
      expect(out.code).toBe(0);
      expect(out.data.status).toBe('ok'); // sem remoto, ok com aviso
    }
  });

  it('cabecao-manutencao: status, lint, consolidação, forget em duas chamadas, undo e sync', async () => {
    const [health = [], consolidate = [], forget = [], undo = [], sync = []] = skill('cabecao-manutencao');
    for (const entry of health) {
      const out = await agent('cabecao-manutencao', entry);
      expect(out.json.ok, entry.line).toBe(true);
    }
    const [start, finish] = consolidate;
    if (start === undefined || finish === undefined) throw new Error('blocos da consolidação');
    const started = await agent('cabecao-manutencao', start);
    expect(started.code).toBe(0);
    expect(started.data.consolidation_id).toEqual(expect.any(String));
    expect((await agent('cabecao-manutencao', finish)).code).toBe(0);

    const [ask, confirm] = forget;
    if (ask === undefined || confirm === undefined) throw new Error('blocos do forget');
    const asked = await agent('cabecao-manutencao', ask);
    expect(asked.code).toBe(3);
    expect(asked.data).toMatchObject({ status: 'confirmation_required', summary: expect.any(String) });
    expect(asked.data.confirm_token).toMatch(/^cbc_ct_/);
    const archived = await agent('cabecao-manutencao', confirm);
    expect(archived.code, JSON.stringify(archived.json)).toBe(0);

    const [list, byOp, bySession] = undo;
    if (list === undefined || byOp === undefined || bySession === undefined) throw new Error('blocos do undo');
    expect((await agent('cabecao-manutencao', list)).code).toBe(0);
    // o op é o do forget (uma operação deste agente, pelo id inteiro): desfeita na hora
    const undone = await agent('cabecao-manutencao', byOp);
    expect(undone.code, JSON.stringify(undone.json)).toBe(0);
    const session = await agent('cabecao-manutencao', bySession);
    expect([0, 1], JSON.stringify(session.json)).toContain(session.code);
    for (const entry of sync) expect((await agent('cabecao-manutencao', entry)).data.status).toBe('ok');
  });

  it('cabecao-pedido-explicito: a primeira chamada não grava (código 3); a segunda, com o token, grava aprovada', async () => {
    const [rule = [], control = [], undo = []] = skill('cabecao-pedido-explicito');
    for (const pair of [rule, control, undo]) {
      const [first, second] = pair;
      if (first === undefined || second === undefined) throw new Error('bloco sem as duas chamadas');
      const asked = await agent('cabecao-pedido-explicito', first);
      expect(asked.code, first.line).toBe(3);
      expect(asked.data).toMatchObject({
        status: 'confirmation_required',
        summary: expect.any(String),
        next_step: expect.stringMatching(/pedido explícito do usuário/),
      });
      const done = await agent('cabecao-pedido-explicito', second);
      expect(done.code, `${second.line}: ${JSON.stringify(done.json)}`).toBe(0);
    }
    expect(await readNote(brain, 'AGENTS.md')).toContain('Tudo aqui é inventado, de propósito.');
    const rules = readdirSync(join(brain, 'memory', 'rules'));
    const created = rules.find((name) => name.startsWith('sempre-pnpm'));
    expect(created).toBeDefined();
    expect(await readNote(brain, `memory/rules/${created}`)).toContain('approved_by: user');
  });

  it('todos os comandos dos blocos das skills rodaram', () => {
    const all = SKILLS.flatMap((s) =>
      blocks(s.files.find((file) => file.path === 'SKILL.md')?.content ?? '').flatMap((block) =>
        block.map((entry) => `${s.name}: ${entry.line}`),
      ),
    );
    expect(new Set(ran)).toEqual(new Set(all));
  });
});
