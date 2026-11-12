// Apoio dos testes do banco local: cópia do cérebro de exemplo com o banco aberto, e processos filhos.
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LocalIndex } from '../../src/db/index.ts';
import { openIndex } from '../../src/db/index.ts';
import type { BrainConfig } from '../../src/vault/index.ts';
import { readBrainConfig } from '../../src/vault/index.ts';
import type { TempVault } from '../vault/helpers.ts';
import { copyFixture, makeTempDir } from '../vault/helpers.ts';

export interface OpenVault {
  readonly root: string;
  readonly config: BrainConfig;
  readonly index: LocalIndex;
  /** Fecha o banco ANTES de apagar a pasta (no Windows, arquivo aberto não sai). */
  readonly cleanup: () => Promise<void>;
}

async function withIndex(temp: TempVault): Promise<OpenVault> {
  const config = await readBrainConfig(temp.root);
  const index = await openIndex(temp.root);
  return {
    root: temp.root,
    config,
    index,
    cleanup: async () => {
      index.close();
      await temp.cleanup();
    },
  };
}

/** Cópia do `fixtures/vault` numa pasta temporária, com o banco local aberto (ainda sem varredura). */
export async function openFixture(label: string): Promise<OpenVault> {
  return withIndex(await copyFixture(`db-${label}`));
}

/** Cérebro vazio (só o `.cabecao.json` padrão) com o banco aberto. */
export async function openEmptyVault(label: string): Promise<OpenVault> {
  const temp = await makeTempDir(`db-${label}`);
  await writeFile(
    join(temp.root, '.cabecao.json'),
    `${JSON.stringify({ schemaVersion: 1, noteDirs: ['wiki', 'memory', 'raw'], indexMd: 'index.md' })}\n`,
  );
  return withIndex(temp);
}

/**
 * Os scripts filhos são JavaScript puro, mas importam o código TypeScript. Do Node 22.18 em diante isso funciona
 * sozinho; no 22.16 e 22.17 precisa da remoção de tipos (mesmo padrão de `test/util/helpers.ts`).
 */
const TYPE_FLAGS = process.features.typescript ? [] : ['--experimental-strip-types'];

/**
 * Inicia um script desta pasta com o Node atual. SEM `--no-warnings`: o teste confere que o aviso do SQLite não
 * aparece no stderr.
 */
export function spawnDbChild(script: string, args: string[]): ChildProcess {
  return spawn(process.execPath, [...TYPE_FLAGS, fileURLToPath(new URL(script, import.meta.url)), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

const WORDS = (
  'arquitetura fila consumidor produtor mensagem entrega idempotência lote custo operação plantão cluster ' +
  'decisão contexto consequência projeto equipe serviço banco índice busca trecho título seção sincronização ' +
  'versão publicação teste integração migração roteirização entrega rastreio faturamento auditoria notificação'
).split(' ');

/** Gera `count` notas sintéticas (com frontmatter, seções e wikilinks entre elas) em `root`. Determinístico. */
export async function generateVault(root: string, count: number): Promise<string[]> {
  await writeFile(
    join(root, '.cabecao.json'),
    `${JSON.stringify({ schemaVersion: 1, noteDirs: ['wiki', 'memory', 'raw'], indexMd: 'index.md' })}\n`,
  );
  let seed = 42;
  const random = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const pick = (): string => WORDS[Math.floor(random() * WORDS.length)] ?? 'nota';
  const sentence = (): string => `${Array.from({ length: 12 }, pick).join(' ')}.`;
  const dirs = ['wiki/concepts', 'wiki/entities', 'wiki/decisions', 'memory/gotchas', 'memory/facts'];
  const types = ['concept', 'entity', 'decision', 'gotcha', 'fact'];
  const paths: string[] = [];
  for (const dir of dirs) await mkdir(join(root, ...dir.split('/')), { recursive: true });
  const name = (i: number): string => `nota-${String(i).padStart(5, '0')}`;
  const writes: Promise<void>[] = [];
  for (let i = 0; i < count; i++) {
    const kind = i % dirs.length;
    const path = `${dirs[kind]}/${name(i)}.md`;
    paths.push(path);
    const id = `01K${String(i).padStart(23, '0')}`;
    const link = (): string => `[[${name(Math.floor(random() * count))}]]`;
    const fm =
      types[kind] === 'fact'
        ? `subject: "${link()}"\npredicate: relates_to\nobject: "${link()}"\nvalid_from: 2026-01-01\n`
        : `title: Nota ${i} sobre ${pick()}\nscope: global\nrelated_to: ["${link()}"]\n`;
    const body = [
      types[kind] === 'fact' ? '' : `# Nota ${i} sobre ${pick()}\n`,
      `${sentence()} ${sentence()} Veja ${link()}.\n`,
      `## Contexto\n\n${sentence()} ${sentence()} ${sentence()}\n`,
      `## Consequência\n\n${sentence()} ${link()} ${sentence()}\n`,
    ].join('\n');
    writes.push(writeFile(join(root, ...path.split('/')), `---\nid: ${id}\ntype: ${types[kind]}\n${fm}---\n${body}`));
    if (writes.length >= 64) await Promise.all(writes.splice(0));
  }
  await Promise.all(writes);
  return paths;
}
