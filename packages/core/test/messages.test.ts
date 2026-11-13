// Mensagens, descrições e textos que vão ao usuário ou ao agente só citam comandos e tools que existem
// (revisão adversária, M8): um "rode cabecao reindex" ou um "use handoff_save" manda o agente atrás do que não há.
// Confere os textos entre aspas (fora de comentários) do código-fonte dos três pacotes.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const COMMANDS = [
  'init',
  'status',
  'doctor',
  'sync',
  'search',
  'graph',
  'facts',
  'undo',
  'mcp',
  'install-client',
  'embeddings',
  'compact',
  'eval',
  'reindex',
  'recall',
  'schedule',
];
/** Palavras que seguem "cabecao" em prosa ("o cabecao precisa de..."), não comandos. */
const PROSE = ['precisa', 'para', 'não'];
/** Tools e comandos que NÃO existem e já apareceram em mensagens. */
const MISSING_TOOLS = /\b(?:handoff_save|forget|listOperations)\b/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** Textos entre aspas simples, duplas ou crases, das linhas que não são comentário. */
function literals(file: string): string[] {
  const code = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    .join('\n');
  return (code.match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? []).map((text) =>
    text.slice(1, -1),
  );
}

describe('textos só citam o que existe', () => {
  const files = ['packages/core/src', 'packages/server/src', 'packages/cli/src'].flatMap((dir) =>
    sourceFiles(join(REPO, dir)),
  );

  it('acha os arquivos', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('todo "cabecao <comando>" é um comando da CLI', () => {
    const wrong: string[] = [];
    for (const file of files) {
      for (const text of literals(file)) {
        for (const match of text.matchAll(/\bcabecao (\p{Ll}[\p{Ll}-]*)/gu)) {
          const command = match[1] ?? '';
          if (!COMMANDS.includes(command) && !PROSE.includes(command)) {
            wrong.push(`${relative(REPO, file)}: ${match[0]}`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('nenhum texto manda usar tool que não existe (handoff_save, forget, listOperations)', () => {
    const wrong: string[] = [];
    for (const file of files) {
      for (const text of literals(file)) {
        const match = MISSING_TOOLS.exec(text);
        if (match !== null) wrong.push(`${relative(REPO, file)}: ${match[0]} em "${text.slice(0, 80)}"`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
