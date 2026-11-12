// `index.md` é derivado: o sync o regenera dentro de cada commit que integra, então ele nunca conflita.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { splitFrontmatter } from '../markdown/index.ts';
import { ATOMIC_TMP_PREFIX, ATOMIC_TMP_SUFFIX, normalizeNfc, writeFileAtomic } from '../util/index.ts';
import type { BrainConfig, IndexEntry } from '../vault/index.ts';
import { isInNoteDirs, LOG_MD, renderIndexMd } from '../vault/index.ts';
import { editTree, type GitContext, listTree, readObjects, type TreeEntry, writeBlob } from './git.ts';

/** O que o catálogo precisa de uma nota. */
export interface NoteMeta {
  readonly type: string | null;
  readonly validUntil: string | null;
}

export function noteMetaFromText(text: string): NoteMeta {
  const { data } = splitFrontmatter(text);
  return {
    type: typeof data.type === 'string' ? data.type : null,
    validUntil: typeof data.valid_until === 'string' ? data.valid_until : null,
  };
}

/**
 * Mesmo critério de `listNoteFiles` (vault), aplicado a um caminho de uma árvore do git: `.md` dentro das
 * `noteDirs`, fora de pastas ocultas, sem os temporários da escrita atômica, sem o catálogo e sem o diário.
 */
export function isCatalogNote(path: string, config: Pick<BrainConfig, 'noteDirs' | 'indexMd'>): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name.length <= 3 || name.slice(-3).toLowerCase() !== '.md') return false;
  if (name.startsWith(ATOMIC_TMP_PREFIX) && name.endsWith(ATOMIC_TMP_SUFFIX)) return false;
  if (path.split('/').some((segment) => segment.startsWith('.'))) return false;
  const lower = normalizeNfc(path).toLowerCase();
  if (lower === normalizeNfc(config.indexMd).toLowerCase() || lower === LOG_MD) return false;
  return isInNoteDirs(normalizeNfc(path), config);
}

/** Tipo e validade por SHA de blob. Persistido em `.cabecao/sync/`: um blob nunca muda, então nunca envelhece. */
export class CatalogCache {
  readonly file: string;
  private readonly entries = new Map<string, NoteMeta>();
  /** Blobs usados neste processo: é o que fica no arquivo. */
  private readonly used = new Set<string>();
  private dirty = false;

  constructor(file: string) {
    this.file = file;
  }

  async load(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (typeof raw !== 'object' || raw === null) return;
      for (const [oid, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!Array.isArray(value)) continue;
        const [type, validUntil] = value as unknown[];
        this.entries.set(oid, {
          type: typeof type === 'string' ? type : null,
          validUntil: typeof validUntil === 'string' ? validUntil : null,
        });
      }
    } catch {
      // sem cache (ou cache estragado): é só reler os blobs
    }
  }

  get(oid: string): NoteMeta | undefined {
    this.used.add(oid);
    return this.entries.get(oid);
  }

  set(oid: string, meta: NoteMeta): void {
    this.used.add(oid);
    this.entries.set(oid, meta);
    this.dirty = true;
  }

  /** Grava só os blobs usados nesta execução, para o arquivo não crescer para sempre. */
  async save(): Promise<void> {
    if (!this.dirty) return;
    const out: Record<string, [string | null, string | null]> = {};
    for (const [oid, meta] of this.entries) if (this.used.has(oid)) out[oid] = [meta.type, meta.validUntil];
    await writeFileAtomic(this.file, JSON.stringify(out));
    this.dirty = false;
  }
}

/** SHA que o git daria a um blob com este conteúdo (sha1 ou sha256, pelo tamanho dos SHAs do repositório). */
export function blobId(data: Uint8Array, oidLength: number): string {
  return createHash(oidLength === 64 ? 'sha256' : 'sha1')
    .update(`blob ${data.length}\0`)
    .update(data)
    .digest('hex');
}

export interface CatalogInput extends GitContext {
  readonly config: Pick<BrainConfig, 'noteDirs' | 'indexMd'>;
  readonly cache: CatalogCache;
}

/**
 * Conteúdo do `index.md` para as notas de uma árvore. `overrides` troca ou acrescenta notas (metadados lidos do
 * disco) e, com `null`, remove: serve para o commit das edições, cuja árvore ainda não existe.
 */
export async function renderCatalog(
  input: CatalogInput,
  entries: readonly TreeEntry[],
  overrides: ReadonlyMap<string, NoteMeta | null> = new Map(),
): Promise<string> {
  const { config, cache } = input;
  const notes = new Map<string, { oid: string | null; meta: NoteMeta | undefined }>();
  for (const entry of entries) {
    if (entry.type !== 'blob' || !isCatalogNote(entry.path, config)) continue;
    notes.set(normalizeNfc(entry.path), { oid: entry.oid, meta: cache.get(entry.oid) });
  }
  for (const [path, meta] of overrides) {
    const key = normalizeNfc(path);
    if (meta === null) notes.delete(key);
    else if (isCatalogNote(key, config)) notes.set(key, { oid: null, meta });
  }
  const missing = [...notes.values()].filter((n) => n.meta === undefined && n.oid !== null).map((n) => n.oid as string);
  if (missing.length > 0) {
    const blobs = await readObjects(input, missing);
    for (const note of notes.values()) {
      if (note.meta !== undefined || note.oid === null) continue;
      const meta = noteMetaFromText(blobs.get(note.oid)?.toString('utf8') ?? '');
      cache.set(note.oid, meta);
      note.meta = meta;
    }
  }
  const list: IndexEntry[] = [];
  for (const [path, note] of notes) {
    list.push({ path, type: note.meta?.type ?? null, validUntil: note.meta?.validUntil ?? null });
  }
  return renderIndexMd(list, { groupOrder: config.noteDirs });
}

/** Devolve a árvore com o `index.md` correto para as notas dela (a mesma árvore, se já estava certo). */
export async function withCatalog(input: CatalogInput, tree: string): Promise<string> {
  const entries = await listTree(input, tree);
  const content = await renderCatalog(input, entries);
  const data = Buffer.from(content, 'utf8');
  const current = entries.find((entry) => normalizeNfc(entry.path) === input.config.indexMd)?.oid;
  if (current === blobId(data, tree.length)) return tree;
  const oid = await writeBlob(input, data);
  return editTree(input, tree, [{ path: input.config.indexMd, oid }]);
}
