// Confere as invariantes do cérebro de exemplo em fixtures/vault.
// O leitor abaixo é só o bastante para este teste; o parser de verdade é entrega do marco 1.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const VAULT = fileURLToPath(new URL('../../../fixtures/vault', import.meta.url));

const NOTE_TYPES = [
  'source',
  'concept',
  'entity',
  'decision',
  'synthesis',
  'rule',
  'preference',
  'gotcha',
  'procedure',
  'fact',
  'episode',
  'handoff',
];
const RELATIONS = ['uses', 'part_of', 'depends_on', 'decided_by', 'works_on', 'related_to'];
const LINK_PROPERTIES = [...RELATIONS, 'supersedes', 'superseded_by', 'sources'];
const WIKILINK = /(!?)\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

interface Note {
  path: string;
  frontmatter: Record<string, unknown> | undefined;
  body: string;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function readNote(file: string): Note {
  const text = readFileSync(file, 'utf8');
  const path = relative(VAULT, file).split(sep).join('/');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { path, frontmatter: undefined, body: text };
  return { path, frontmatter: parse(match[1] ?? '') as Record<string, unknown>, body: match[2] ?? '' };
}

function withoutCode(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

interface Link {
  target: string;
  embed: boolean;
  section: string | undefined;
  alias: string | undefined;
}

function wikilinks(text: string): Link[] {
  return [...text.matchAll(WIKILINK)].map((m) => ({
    target: (m[2] ?? '').trim(),
    embed: m[1] === '!',
    section: m[3],
    alias: m[4],
  }));
}

function asList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

const files = walk(VAULT);
const markdown = files.filter((file) => file.endsWith('.md')).map(readNote);
const inNoteDirs = markdown.filter((note) => /^(wiki|memory|raw)\//.test(note.path));
const notes = inNoteDirs.filter((note) => typeof note.frontmatter?.id === 'string');

// Como no Obsidian: um link resolve pelo nome do arquivo ou pelo caminho, sem diferenciar maiúsculas.
const targets = new Set(
  markdown.flatMap((note) => {
    const withoutExt = note.path.replace(/\.md$/, '');
    return [withoutExt, basename(withoutExt)].map((name) => name.normalize('NFC').toLowerCase());
  }),
);
const resolves = (target: string) => targets.has(target.normalize('NFC').toLowerCase());

function frontmatterLinks(note: Note): Link[] {
  const values = [...LINK_PROPERTIES, 'subject', 'object'].flatMap((key) => asList(note.frontmatter?.[key]));
  return values.flatMap(wikilinks);
}

describe('cérebro de exemplo (fixtures/vault)', () => {
  it('tem a estrutura do modelo de dados', () => {
    const config = JSON.parse(readFileSync(join(VAULT, '.cabecao.json'), 'utf8'));
    expect(config).toEqual({ schemaVersion: 1, noteDirs: ['wiki', 'memory', 'raw'], indexMd: 'index.md' });
    const paths = files.map((file) => relative(VAULT, file).split(sep).join('/'));
    for (const required of ['.gitattributes', '.gitignore', 'AGENTS.md', 'CLAUDE.md', 'index.md', 'log.md']) {
      expect(paths).toContain(required);
    }
    expect(paths.some((path) => path.startsWith('.cabecao/'))).toBe(false);
  });

  it('tem notas de todos os tipos, e só de tipos conhecidos', () => {
    const types = notes.map((note) => String(note.frontmatter?.type));
    expect([...new Set(types)].sort()).toEqual([...NOTE_TYPES].sort());
    expect(notes).toHaveLength(23);
  });

  it('cada nota tem ULID único, origem, confiança e datas no formato ISO', () => {
    const ids = notes.map((note) => String(note.frontmatter?.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const note of notes) {
      const fm = note.frontmatter ?? {};
      expect(fm.id, note.path).toMatch(ULID);
      expect(['high', 'medium', 'low'], note.path).toContain(fm.trust);
      expect(String(fm.origin), note.path).toMatch(/^(human|agent:[\w-]+|ingest:[\w-]+)$/);
      for (const key of ['created', 'updated', 'confirmed', 'valid_from', 'valid_until', 'expires_at']) {
        if (fm[key] !== undefined && fm[key] !== null) expect(String(fm[key]), `${note.path} ${key}`).toMatch(ISO_DATE);
      }
      if (fm.type !== 'fact') {
        expect(typeof fm.title, note.path).toBe('string');
        expect(String(fm.scope), note.path).toMatch(/^(global|project:[\w-]+)$/);
      }
    }
  });

  it('usa todas as relações tipadas, cada uma como lista de wikilinks', () => {
    for (const relation of RELATIONS) {
      const users = notes.filter((note) => note.frontmatter?.[relation] !== undefined);
      expect(users.length, relation).toBeGreaterThan(0);
      for (const note of users) {
        const value = note.frontmatter?.[relation];
        expect(Array.isArray(value), `${note.path} ${relation}`).toBe(true);
        for (const item of asList(value)) expect(item, `${note.path} ${relation}`).toMatch(/^\[\[[^\]]+\]\]$/);
      }
    }
    expect(notes.some((note) => 'relations' in (note.frontmatter ?? {}))).toBe(false);
  });

  it('tem fatos com validade no tempo, vencidos e vigentes, encadeados sem buracos', () => {
    const facts = notes.filter((note) => note.frontmatter?.type === 'fact');
    expect(facts).toHaveLength(4);
    for (const fact of facts) {
      const fm = fact.frontmatter ?? {};
      expect(String(fm.subject), fact.path).toMatch(/^\[\[[^\]]+\]\]$/);
      expect(String(fm.object), fact.path).toMatch(/^\[\[[^\]]+\]\]$/);
      expect(String(fm.predicate), fact.path).toMatch(/^[a-z_]+$/);
      expect(String(fm.valid_from), fact.path).toMatch(ISO_DATE);
    }
    const byName = new Map(facts.map((fact) => [basename(fact.path, '.md'), fact.frontmatter ?? {}]));
    for (const predicate of ['uses_queue', 'led_by']) {
      const group = facts.filter((fact) => fact.frontmatter?.predicate === predicate);
      const expired = group.filter((fact) => fact.frontmatter?.valid_until != null);
      const current = group.filter((fact) => fact.frontmatter?.valid_until == null);
      expect(expired, predicate).toHaveLength(1);
      expect(current, predicate).toHaveLength(1);
      const [oldFact] = expired;
      const [newFact] = current;
      // O fato novo começa no dia em que o antigo termina, e os dois apontam um para o outro.
      expect(newFact?.frontmatter?.valid_from).toBe(oldFact?.frontmatter?.valid_until);
      const successor = wikilinks(asList(oldFact?.frontmatter?.superseded_by).join(' '))[0]?.target ?? '';
      const predecessor = wikilinks(asList(newFact?.frontmatter?.supersedes).join(' '))[0]?.target ?? '';
      expect(byName.get(successor)).toBe(newFact?.frontmatter);
      expect(byName.get(predecessor)).toBe(oldFact?.frontmatter);
    }
  });

  it('todo valid_until vem depois do valid_from', () => {
    const dated = notes.filter((note) => note.frontmatter?.valid_until != null);
    expect(dated.length).toBeGreaterThanOrEqual(4);
    for (const note of dated) {
      expect(String(note.frontmatter?.valid_until) > String(note.frontmatter?.valid_from), note.path).toBe(true);
    }
  });

  it('todos os wikilinks resolvem, menos o que é quebrado de propósito', () => {
    const broken = new Set<string>();
    for (const note of markdown) {
      for (const link of [...wikilinks(withoutCode(note.body)), ...frontmatterLinks(note)]) {
        if (!resolves(link.target)) broken.add(`${note.path} -> ${link.target}`);
      }
    }
    expect([...broken]).toEqual(['wiki/concepts/Fila de mensagens.md -> Kafka']);
  });

  it('cobre as formas de wikilink: apelido, seção, embutido, por caminho e com outra caixa', () => {
    const links = markdown.flatMap((note) => wikilinks(withoutCode(note.body)));
    expect(links.some((link) => link.alias !== undefined)).toBe(true);
    expect(links.some((link) => link.section !== undefined && !link.embed)).toBe(true);
    expect(links.some((link) => link.embed)).toBe(true);
    expect(links.some((link) => link.target.includes('/'))).toBe(true);
    expect(links.some((link) => link.target === 'projeto atlas')).toBe(true);
  });

  it('não conta como link o que está dentro de código', () => {
    const note = markdown.find((candidate) => candidate.path === 'wiki/concepts/Fila de mensagens.md');
    expect(note?.body).toContain('[[Isto não é um link]]');
    const found = wikilinks(withoutCode(note?.body ?? '')).map((link) => link.target);
    expect(found).not.toContain('Isto não é um link');
    expect(found).not.toContain('código na linha');
  });

  it('tem nomes de arquivo com acento, gravados em NFC', () => {
    const accented = markdown.filter((note) => /[^\p{ASCII}]/u.test(note.path));
    expect(accented.length).toBeGreaterThanOrEqual(3);
    for (const note of markdown) expect(note.path, note.path).toBe(note.path.normalize('NFC'));
  });

  it('tem fontes brutas sem o frontmatter do Cabeção', () => {
    const raw = inNoteDirs.filter((note) => note.path.startsWith('raw/'));
    expect(raw).toHaveLength(2);
    expect(raw.filter((note) => note.frontmatter === undefined)).toHaveLength(1);
    for (const note of raw) expect(note.frontmatter?.id).toBeUndefined();
  });

  it('tem uma memória arquivada e um handoff com data de expiração', () => {
    expect(notes.filter((note) => note.path.startsWith('memory/_archive/'))).toHaveLength(1);
    const handoff = notes.find((note) => note.frontmatter?.type === 'handoff');
    expect(String(handoff?.frontmatter?.expires_at)).toMatch(ISO_DATE);
  });
});
