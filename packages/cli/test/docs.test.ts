// A documentação em dia com o código (auditoria de UX, item 3): os números e as listas que o site e os READMEs afirmam
// (quantidade de tools, comandos, clientes) batem com o registro de comandos, com as tools do servidor e com os clientes
// do install-client. Um PR que acrescenta um comando, uma tool ou um cliente sem atualizar a documentação falha aqui.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASK_TOOL_NAME, TOOL_NAMES } from '@cabecao/server';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/commands.ts';
import { CLIENT_IDS, CLIENTS } from '../src/install-client/clients.ts';
import { SKILL_CLIENTS } from '../src/skills/targets.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string) => readFileSync(join(REPO, ...path.split('/')), 'utf8');
const EN = 'docs/i18n/en/docusaurus-plugin-content-docs/current';

/** Arquivos que afirmam o estado ATUAL (a página "Novidades" conta a história de cada versão e fica de fora). */
const CURRENT = [
  'README.md',
  'README.en.md',
  'packages/cli/README.md',
  'integrations/claude-code/README.md',
  'docs/src/pages/index.tsx',
  'docs/i18n/en/code.json',
  ...['guias/claude-desktop.md', 'referencia/mcp.md', 'comecar/conectar-clientes.md', 'em-breve.md'].flatMap((page) => [
    `docs/docs/${page}`,
    `${EN}/${page}`,
  ]),
];

describe('documentação em dia com o código', () => {
  // `TOOL_NAMES` são as tools sempre anunciadas; a `ask` só aparece com um provedor de respostas ativado na máquina, então
  // a contagem da documentação é a das sempre anunciadas, e a `ask` tem de estar documentada como condicional.
  it('toda contagem de tools é a do servidor', () => {
    const wrong: string[] = [];
    for (const file of CURRENT) {
      for (const match of read(file).matchAll(/\b(\d+) tools\b/g)) {
        if (Number(match[1]) !== TOOL_NAMES.length) wrong.push(`${file}: "${match[0]}" (são ${TOOL_NAMES.length})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('a referência das tools (nos dois idiomas) tem uma seção por tool', () => {
    for (const file of ['docs/docs/referencia/mcp.md', `${EN}/referencia/mcp.md`]) {
      const sections = [...read(file).matchAll(/^## ([a-z_]+)$/gm)].map((match) => match[1]);
      expect(
        [...TOOL_NAMES, ASK_TOOL_NAME].filter((tool) => !sections.includes(tool)),
        file,
      ).toEqual([]);
    }
    expect(TOOL_NAMES).not.toContain(ASK_TOOL_NAME);
    // a linha da `ask` na tabela diz que ela só aparece com o provedor ativado
    expect(read('docs/docs/referencia/mcp.md')).toMatch(/\| \[`ask`\]\(#ask\) \|[^\n]*Só aparece com `cabecao llm on`/);
    expect(read(`${EN}/referencia/mcp.md`)).toMatch(
      /\| \[`ask`\]\(#ask\) \|[^\n]*Only shows up after `cabecao llm on`/,
    );
  });

  it('a referência da CLI (nos dois idiomas) e o README do npm citam todos os comandos', () => {
    for (const file of ['docs/docs/referencia/cli.md', `${EN}/referencia/cli.md`]) {
      const sections = [...read(file).matchAll(/^## cabecao ([a-z-]+)$/gm)].map((match) => match[1]);
      expect(
        COMMANDS.map((command) => command.name).filter((name) => !sections.includes(name)),
        file,
      ).toEqual([]);
    }
    const npm = read('packages/cli/README.md');
    expect(COMMANDS.map((command) => command.name).filter((name) => !npm.includes(`\`cabecao ${name}`))).toEqual([]);
  });

  it('os clientes do install-client e do install-skills aparecem nos READMEs e em "Conectar clientes"', () => {
    for (const file of [
      'README.md',
      'README.en.md',
      'docs/docs/comecar/conectar-clientes.md',
      `${EN}/comecar/conectar-clientes.md`,
    ]) {
      const text = read(file);
      expect(
        CLIENT_IDS.filter((id) => !text.includes(CLIENTS[id].label)),
        file,
      ).toEqual([]);
    }
    for (const file of ['docs/docs/guias/skills.md', `${EN}/guias/skills.md`]) {
      const text = read(file);
      expect(
        SKILL_CLIENTS.filter((id) => !text.includes(`\`${id}\``)),
        file,
      ).toEqual([]);
    }
  });

  it('a página "Em breve" não promete o que já existe', () => {
    for (const file of ['docs/docs/em-breve.md', `${EN}/em-breve.md`]) {
      const text = read(file);
      for (const done of ['install-skills', 'cabecao uninstall', 'Plugin do Claude Code', 'Claude Code plugin']) {
        expect(text.includes(done), `${file}: ${done}`).toBe(false);
      }
    }
  });
});
