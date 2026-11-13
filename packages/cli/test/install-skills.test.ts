// `cabecao install-skills` e `cabecao uninstall`, numa pasta do usuário FALSA (HOME, USERPROFILE, APPDATA,
// XDG_CONFIG_HOME e CABECAO_CONFIG_DIR temporários; nenhuma pasta real de cliente é lida ou escrita) e com o executor
// de programas falso (nenhum `claude` roda).
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Location } from '../src/install-client/clients.ts';
import { SKILLS } from '../src/skills/content.ts';
import { skillsDir } from '../src/skills/targets.ts';
import {
  answering,
  brainRepo,
  disposeSandbox,
  freshDir,
  HUMAN,
  machine,
  parseJson,
  TEST_TIMEOUT_MS,
} from './helpers.ts';

afterAll(disposeSandbox);

const NAMES = SKILLS.map((skill) => skill.name);
const skillFile = (dir: string, name: string) => join(dir, name, 'SKILL.md');

describe('pastas de skills por cliente', () => {
  const location = (platform: NodeJS.Platform, env: Record<string, string> = {}): Location => ({
    platform,
    env,
    home: platform === 'win32' ? 'C:\\Users\\ana' : '/home/ana',
  });

  it('usuário: Claude Code, Antigravity e VS Code próprias; Codex, Cursor e Gemini CLI dividem ~/.agents/skills', () => {
    const l = location('linux');
    expect(skillsDir('claude-code', 'user', l, '/p')).toBe('/home/ana/.claude/skills');
    expect(skillsDir('codex', 'user', l, '/p')).toBe('/home/ana/.agents/skills');
    expect(skillsDir('cursor', 'user', l, '/p')).toBe('/home/ana/.agents/skills');
    expect(skillsDir('gemini', 'user', l, '/p')).toBe('/home/ana/.agents/skills');
    expect(skillsDir('antigravity', 'user', l, '/p')).toBe('/home/ana/.gemini/config/skills');
    expect(skillsDir('vscode', 'user', l, '/p')).toBe('/home/ana/.copilot/skills');
    expect(skillsDir('claude-code', 'user', location('linux', { CLAUDE_CONFIG_DIR: '/cfg/claude' }), '/p')).toBe(
      '/cfg/claude/skills',
    );
    expect(skillsDir('vscode', 'user', location('darwin', { COPILOT_HOME: '/cfg/copilot' }), '/p')).toBe(
      '/cfg/copilot/skills',
    );
    expect(skillsDir('codex', 'user', location('win32'), 'C:\\p')).toBe('C:\\Users\\ana\\.agents\\skills');
  });

  it('projeto: .claude/skills, .github/skills e .agents/skills na pasta atual', () => {
    const l = location('darwin');
    expect(skillsDir('claude-code', 'project', l, '/p')).toBe('/p/.claude/skills');
    expect(skillsDir('vscode', 'project', l, '/p')).toBe('/p/.github/skills');
    for (const id of ['codex', 'cursor', 'gemini', 'antigravity'] as const) {
      expect(skillsDir(id, 'project', l, '/p')).toBe('/p/.agents/skills');
    }
  });
});

describe('install-skills', { timeout: TEST_TIMEOUT_MS }, () => {
  it('instala nos detectados, é idempotente, não sobrescreve o que você alterou e --remove tira só o do Cabeção', async () => {
    const m = machine();
    await mkdir(join(m.home, '.claude'), { recursive: true });
    await mkdir(join(m.home, '.codex'), { recursive: true });
    const claude = join(m.home, '.claude', 'skills');
    const agents = join(m.home, '.agents', 'skills');

    const first = await m.cabecao(['install-skills']);
    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(/Claude Code: ~[\\/]\.claude[\\/]skills/);
    expect(first.stdout).toMatch(/Codex: ~[\\/]\.agents[\\/]skills/);
    expect(first.stdout).toContain('cabecao-consultar: instalada');
    for (const name of NAMES) {
      expect(existsSync(skillFile(claude, name))).toBe(true);
      expect(existsSync(skillFile(agents, name))).toBe(true);
    }
    const registry = JSON.parse(await readFile(join(m.configDir, 'skills.json'), 'utf8'));
    expect(registry.installs.map((install: { dir: string }) => install.dir).sort()).toEqual([agents, claude].sort());

    const again = parseJson(await m.cabecao(['install-skills', '--json']));
    const outcomes = again.data.results.flatMap((result: { files: { outcome: string }[] }) =>
      result.files.map((file) => file.outcome),
    );
    expect(new Set(outcomes)).toEqual(new Set(['unchanged']));

    // você altera uma skill: ela nunca é sobrescrita nem removida
    const mine = skillFile(claude, 'cabecao-lembrar');
    await writeFile(mine, 'minha versão\n');
    const kept = await m.cabecao(['install-skills', 'claude-code']);
    expect(kept.stdout).toContain('cabecao-lembrar: mantida como está');
    expect(await readFile(mine, 'utf8')).toBe('minha versão\n');

    // uma skill sua com o mesmo nome, numa pasta onde o Cabeção nunca instalou: também fica
    const project = freshDir('projeto');
    await mkdir(join(project, '.agents', 'skills', 'cabecao-consultar'), { recursive: true });
    await writeFile(skillFile(join(project, '.agents', 'skills'), 'cabecao-consultar'), 'do projeto\n');
    const inProject = await m.cabecao(['install-skills', 'codex', '--project'], { cwd: project });
    expect(inProject.stdout).toContain('cabecao-consultar: mantida como está');
    expect(existsSync(skillFile(join(project, '.agents', 'skills'), 'cabecao-lembrar'))).toBe(true);

    const removed = await m.cabecao(['install-skills', '--remove']);
    expect(removed.code).toBe(0);
    expect(existsSync(skillFile(claude, 'cabecao-consultar'))).toBe(false);
    expect(existsSync(join(claude, 'cabecao-consultar'))).toBe(false);
    expect(await readFile(mine, 'utf8')).toBe('minha versão\n');
    expect(existsSync(skillFile(agents, 'cabecao-consultar'))).toBe(false);
    // o --remove sem --project não toca no projeto
    expect(existsSync(skillFile(join(project, '.agents', 'skills'), 'cabecao-lembrar'))).toBe(true);
    expect(m.calls).toEqual([]);
  });

  it('pasta dividida: tirar o Codex mantém as skills enquanto o Cursor usa a mesma pasta', async () => {
    const m = machine();
    expect((await m.cabecao(['install-skills', 'codex', 'cursor'])).code).toBe(0);
    const agents = join(m.home, '.agents', 'skills');
    const out = await m.cabecao(['install-skills', '--remove', 'codex']);
    expect(out.stdout).toContain('as skills continuam lá: Cursor também usa esta pasta');
    expect(existsSync(skillFile(agents, 'cabecao-consultar'))).toBe(true);
    await m.cabecao(['install-skills', '--remove', 'cursor']);
    expect(existsSync(skillFile(agents, 'cabecao-consultar'))).toBe(false);
  });

  it('--print não grava nada; --instructions mostra o bloco para o AGENTS.md; Claude Desktop e nome errado são recusados', async () => {
    const m = machine();
    const printed = await m.cabecao(['install-skills', '--print', 'antigravity']);
    expect(printed.code).toBe(0);
    expect(printed.stdout).toMatch(/# Antigravity: ~[\\/]\.gemini[\\/]config[\\/]skills/);
    expect(printed.stdout).toContain('Nada foi gravado (--print)');
    expect(printed.stdout).toContain('name: cabecao-consultar');
    expect(existsSync(join(m.home, '.gemini'))).toBe(false);
    expect(existsSync(join(m.configDir, 'skills.json'))).toBe(false);

    const block = await m.cabecao(['install-skills', '--instructions']);
    expect(block.stdout).toContain('O Cabeção não edita esse arquivo por você');
    expect(block.stdout).toContain('cabecao recall "<tarefa>" --json');

    const desktop = await m.cabecao(['install-skills', 'claude-desktop']);
    expect(desktop.code).toBe(1);
    expect(desktop.stderr).toContain('servidor MCP');
    const typo = await m.cabecao(['install-skills', 'claude']);
    expect(typo.code).toBe(2);
    expect(typo.stderr).toContain('Você quis dizer "claude-code"?');
  });

  it('sem agente detectado: diz o que fazer, sem gravar nada', async () => {
    const m = machine();
    const out = await m.cabecao(['install-skills']);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('Nenhum agente com skills foi detectado');
    expect(out.stdout).toContain('cabecao install-skills --instructions');
  });

  it('o doctor confere as skills: em dia, e desatualizadas com a correção', async () => {
    const m = machine();
    const brain = await brainRepo();
    await m.cabecao(['install-skills', 'cursor']);
    const ok = parseJson(await m.cabecao(['doctor', '--offline', '--brain', brain, '--json']));
    expect(ok.data.checks.find((check: { id: string }) => check.id === 'skills')).toMatchObject({
      status: 'ok',
      message: 'instaladas e em dia',
    });
    // simula uma versão anterior: o arquivo é o que o Cabeção gravou (o hash do registro), mas não o desta versão
    const file = skillFile(join(m.home, '.agents', 'skills'), 'cabecao-consultar');
    const registryPath = join(m.configDir, 'skills.json');
    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    await writeFile(file, 'versão antiga\n');
    const { createHash } = await import('node:crypto');
    registry.installs[0].files['cabecao-consultar/SKILL.md'] = createHash('sha256')
      .update('versão antiga\n')
      .digest('hex');
    await writeFile(registryPath, JSON.stringify(registry));
    const stale = parseJson(await m.cabecao(['doctor', '--offline', '--brain', brain, '--json']));
    expect(stale.data.checks.find((check: { id: string }) => check.id === 'skills')).toMatchObject({
      status: 'warn',
      fix: expect.stringContaining('cabecao install-skills cursor'),
    });
    // e rodar de novo atualiza (era do Cabeção)
    const updated = await m.cabecao(['install-skills', 'cursor']);
    expect(updated.stdout).toContain('cabecao-consultar: atualizada');
  });
});

describe('uninstall', { timeout: TEST_TIMEOUT_MS }, () => {
  async function installedMachine() {
    const m = machine();
    const brain = await brainRepo();
    await mkdir(join(m.home, '.cursor'), { recursive: true });
    await mkdir(join(m.configDir), { recursive: true });
    await writeFile(join(m.configDir, 'config.json'), JSON.stringify({ machine: 'm', defaultBrain: brain }));
    expect((await m.cabecao(['install-client', '--all'])).code).toBe(0);
    expect((await m.cabecao(['install-skills'])).code).toBe(0);
    const cache = join(m.home, 'cache', 'cabecao');
    await mkdir(join(cache, 'models'), { recursive: true });
    await writeFile(join(cache, 'models', 'x.onnx'), 'x');
    const env = { ...m.env, CABECAO_CACHE_DIR: cache };
    return { m, brain, cache, env };
  }

  it('--dry-run mostra o que sairia e não remove nada; qualquer um (até um agente) pode ver', async () => {
    const { m, brain, cache, env } = await installedMachine();
    const out = await m.cabecao(['uninstall', '--dry-run'], { env });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('nada foi feito');
    expect(out.stdout).toMatch(/registro do servidor MCP no Cursor: ~[\\/]\.cursor[\\/]mcp\.json/);
    expect(out.stdout).toMatch(/skills do Cabeção em ~[\\/]\.agents[\\/]skills/);
    expect(out.stdout).toContain('configuração da máquina');
    expect(out.stdout).toContain('cache (runtime e modelos');
    expect(out.stdout).toContain(`Fica: o cérebro em `);
    expect(existsSync(join(m.home, '.cursor', 'mcp.json'))).toBe(true);
    expect(existsSync(cache)).toBe(true);
    expect(existsSync(join(brain, '.cabecao.json'))).toBe(true);
  });

  it('sem terminal (um agente), remover é recusado com o código 4', async () => {
    const { m, env } = await installedMachine();
    const out = await m.cabecao(['uninstall'], { env });
    expect(out.code).toBe(4);
    expect(out.stderr).toContain('só remove com a confirmação do usuário');
    expect(existsSync(join(m.configDir, 'config.json'))).toBe(true);
  });

  it('o usuário diz não: nada sai; diz sim: sai tudo, menos o cérebro', async () => {
    const { m, brain, cache, env } = await installedMachine();
    const no = await m.cabecao(['uninstall'], { env, ...answering([], 'n') });
    expect(no.code).toBe(1);
    expect(no.stdout).toContain('Nada foi removido.');
    expect(existsSync(join(m.configDir, 'config.json'))).toBe(true);

    const asked: string[] = [];
    const yes = await m.cabecao(['uninstall'], { env, ...answering(asked, 's') });
    expect(asked).toEqual(['Remover? [s/N] ']);
    expect(yes.code, yes.stdout + yes.stderr).toBe(0);
    expect(yes.stdout).toContain('registro removido do Cursor');
    const cursor = JSON.parse(await readFile(join(m.home, '.cursor', 'mcp.json'), 'utf8'));
    expect(cursor.mcpServers.cabecao).toBeUndefined();
    expect(existsSync(skillFile(join(m.home, '.agents', 'skills'), 'cabecao-consultar'))).toBe(false);
    // a pasta de config do teste não se chama "cabecao": só os arquivos do Cabeção saem (e a pasta, se ficou vazia)
    expect(existsSync(join(m.configDir, 'config.json'))).toBe(false);
    expect(existsSync(join(m.configDir, 'skills.json'))).toBe(false);
    expect(existsSync(cache)).toBe(false);
    expect(existsSync(join(brain, '.cabecao.json'))).toBe(true);
    expect(m.calls).toEqual([]);

    const empty = await m.cabecao(['uninstall', '--dry-run'], { env, ...HUMAN });
    expect(empty.stdout).toContain('nada: o Cabeção não deixou');
  });
});
