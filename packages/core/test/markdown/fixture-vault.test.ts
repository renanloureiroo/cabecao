// Roda o parser no cérebro de exemplo (fixtures/vault): todas as notas, sem erro, e uma nota conferida link a link.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ParsedNote } from '../../src/markdown/index.ts';
import { normalizeLinkTarget, parseNote } from '../../src/markdown/index.ts';

const VAULT = fileURLToPath(new URL('../../../../fixtures/vault', import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

// caminho relativo com "/" em qualquer sistema
const notes = new Map<string, ParsedNote>(
  walk(VAULT)
    .filter((file) => file.endsWith('.md'))
    .map((file) => [relative(VAULT, file).split(sep).join('/'), parseNote(readFileSync(file, 'utf8'))]),
);
const note = (path: string): ParsedNote => {
  const found = notes.get(path);
  if (found === undefined) throw new Error(`nota ausente no cérebro de exemplo: ${path}`);
  return found;
};

describe('cérebro de exemplo', () => {
  it('lê todas as notas sem erro de frontmatter', () => {
    expect(notes.size).toBeGreaterThanOrEqual(25);
    for (const [path, parsed] of notes) {
      expect(parsed.frontmatterError, path).toBeNull();
    }
  });

  it('toda nota de wiki/ e memory/ tem frontmatter com id e type, e pelo menos um trecho', () => {
    for (const [path, parsed] of notes) {
      if (!/^(wiki|memory)\//.test(path)) continue;
      expect(parsed.hasFrontmatter, path).toBe(true);
      expect(typeof parsed.frontmatter.id, path).toBe('string');
      expect(typeof parsed.frontmatter.type, path).toBe('string');
      expect(parsed.chunks.length, path).toBeGreaterThan(0);
    }
  });

  it('os trechos têm ordem sequencial, chave de 32 hex e cabem no limite', () => {
    for (const [path, parsed] of notes) {
      parsed.chunks.forEach((chunk, i) => {
        expect(chunk.ord, path).toBe(i);
        expect(chunk.chunkKey, path).toMatch(/^[0-9a-f]{32}$/);
        expect(chunk.tokenCount, path).toBeLessThanOrEqual(350 * 1.5);
        expect(chunk.text.includes('\r'), path).toBe(false);
      });
    }
  });

  it('todo wikilink (corpo e frontmatter) aponta para uma nota que existe, menos o quebrado de propósito', () => {
    const known = new Set<string>();
    for (const path of notes.keys()) {
      known.add(normalizeLinkTarget(path));
      known.add(normalizeLinkTarget(basename(path)));
    }
    let total = 0;
    const broken: string[] = [];
    for (const [path, parsed] of notes) {
      for (const link of [...parsed.links, ...parsed.frontmatterLinks]) {
        total++;
        if (!known.has(normalizeLinkTarget(link.target))) broken.push(`${path} -> ${link.target}`);
      }
    }
    expect(total).toBeGreaterThan(50);
    expect(broken).toEqual(['wiki/concepts/Fila de mensagens.md -> Kafka']);
  });

  it('decisão "usar-sqs-para-filas": título, seções, links do corpo e relações', () => {
    const decision = note('wiki/decisions/usar-sqs-para-filas.md');
    expect(decision.title).toBe('Usar SQS para filas');
    expect(decision.frontmatter).toMatchObject({
      id: '01KNWQPCCGW9YN4PHGN519T4H6',
      type: 'decision',
      scope: 'project:atlas',
      tags: ['infra', 'filas'],
      valid_from: '2026-05-03',
      valid_until: null,
      superseded_by: [],
    });
    expect(decision.headings.map((h) => [h.level, h.text, h.line])).toEqual([
      [1, 'Usar SQS para filas', 23],
      [2, 'Contexto', 27],
      [2, 'Consequência', 31],
    ]);
    expect(decision.links.map((l) => [l.target, l.line, l.headingPath.at(-1)])).toEqual([
      ['Projeto Atlas', 25, 'Usar SQS para filas'],
      ['RabbitMQ', 25, 'Usar SQS para filas'],
      ['SQS', 25, 'Usar SQS para filas'],
      ['Reunião de arquitetura 2026-05-03', 29, 'Contexto'],
      ['Idempotência', 33, 'Consequência'],
    ]);
    expect(decision.links.every((l) => !l.embed && l.alias === null && l.anchor === null)).toBe(true);
    expect(decision.frontmatterLinks.map((l) => [l.property, l.target, l.line])).toEqual([
      ['sources', 'raw/meetings/2026-05-03-arquitetura', 7],
      ['supersedes', 'usar-rabbitmq-para-filas', 15],
      ['uses', 'SQS', 18],
      ['decided_by', 'Ana Prado', 19],
      ['decided_by', 'Bruno Tavares', 19],
      ['part_of', 'Projeto Atlas', 20],
      ['depends_on', 'Idempotência', 21],
    ]);
    expect(decision.chunks.map((c) => c.contextPrefix)).toEqual([
      'Usar SQS para filas',
      'Usar SQS para filas › Contexto',
      'Usar SQS para filas › Consequência',
    ]);
    expect(decision.chunks[2]?.text).toBe(
      'Os consumidores passaram a depender de [[Idempotência]], porque o SQS padrão pode entregar a mesma mensagem mais de uma vez.',
    );
  });

  it('fato "fato-atlas-usa-sqs": subject, object e supersedes', () => {
    const fact = note('memory/facts/fato-atlas-usa-sqs.md');
    expect(fact.frontmatter).toMatchObject({ type: 'fact', predicate: 'uses_queue' });
    expect(fact.frontmatterLinks.map((l) => [l.property, l.target])).toEqual([
      ['subject', 'Projeto Atlas'],
      ['object', 'SQS'],
      ['supersedes', 'fato-atlas-usa-rabbitmq'],
    ]);
    expect(fact.title).toBeNull();
    expect(fact.links).toEqual([]);
    expect(fact.chunks.map((c) => c.embedText)).toEqual([
      'O Projeto Atlas migrou de RabbitMQ para SQS em maio de 2026 por custo operacional.',
    ]);
  });

  it('síntese "Mensageria no Projeto Atlas": embed com seção', () => {
    const synthesis = note('wiki/syntheses/Mensageria no Projeto Atlas.md');
    expect(synthesis.links.filter((l) => l.embed)).toEqual([
      {
        embed: true,
        target: 'usar-sqs-para-filas',
        anchor: 'Consequência',
        alias: null,
        line: 26,
        column: 1,
        headingPath: ['Mensageria no Projeto Atlas'],
      },
    ]);
    expect(synthesis.links.filter((l) => !l.embed).map((l) => l.target)).toEqual([
      'usar-rabbitmq-para-filas',
      'usar-sqs-para-filas',
      '2026-11-10-migracao-dos-consumidores',
    ]);
  });
});
