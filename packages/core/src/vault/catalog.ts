// `index.md` (catálogo gerado) e `log.md` (diário append-only).
import { readFile } from 'node:fs/promises';
import { formatChangeLine } from '../git/index.ts';
import { FileChangedError, fileStamp, normalizeNfc, writeFileAtomic } from '../util/index.ts';
import type { BrainConfig } from './config.ts';
import { LOG_MD } from './config.ts';
import { listNoteFiles } from './list.ts';
import { resolveVaultPath } from './paths.ts';
import { serializeWrites } from './queue.ts';
import { readNote } from './read.ts';
import type { NoteType } from './schema.ts';
import { isArchivedPath, isIsoDate, isNoteType, NOTE_TYPES } from './schema.ts';
import type { WriteResult } from './write.ts';
import { localDate } from './write.ts';

/** O que o catálogo precisa saber de uma nota. O banco local tem tudo isto; `collectIndexEntries` lê do disco. */
export interface IndexEntry {
  /** Caminho relativo, com `/`. */
  readonly path: string;
  /** Notas sem tipo conhecido (fontes brutas, notas não gerenciadas) ficam fora do catálogo. */
  readonly type: string | null;
  /** `valid_until` da nota, se houver. */
  readonly validUntil?: string | null;
}

export interface RenderIndexOptions {
  /** Ordem dos grupos (primeira pasta do caminho); normalmente `config.noteDirs`. Os demais vêm depois, em ordem de código. */
  readonly groupOrder?: readonly string[];
  /**
   * Data `AAAA-MM-DD` de referência para marcar o que venceu (`valid_until` até essa data). Sem ela, toda nota com
   * `valid_until` preenchido é marcada: assim o catálogo depende só do conteúdo das notas, e não do dia em que foi
   * gerado, e duas máquinas geram sempre os mesmos bytes.
   */
  readonly asOf?: string;
}

/** "vencida" ou "vencido", conforme o gênero do tipo em português (a decisão, o fato). */
const EXPIRED_LABEL: Readonly<Record<NoteType, string>> = {
  source: 'vencida',
  concept: 'vencido',
  entity: 'vencida',
  decision: 'vencida',
  synthesis: 'vencida',
  rule: 'vencida',
  preference: 'vencida',
  gotcha: 'vencida',
  procedure: 'vencido',
  fact: 'vencido',
  episode: 'vencido',
  handoff: 'vencido',
};

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const ROOT_GROUP = '(raiz)';

/**
 * Gera o conteúdo do `index.md`. Função pura e determinística: a mesma entrada dá os mesmos bytes em qualquer
 * máquina, sistema e idioma (a ordenação é por código de caractere, nunca por locale; as quebras são sempre LF).
 *
 * Formato: um grupo `## <pasta>` por pasta de primeiro nível e uma linha `- [[nome]] · tipo` por nota, ordenadas
 * pelo tipo (na ordem do doc 03) e depois pelo nome. Notas arquivadas e sem tipo ficam de fora. Quando dois
 * arquivos têm o mesmo nome, o link usa o caminho, para não ser ambíguo.
 */
export function renderIndexMd(entries: readonly IndexEntry[], options: RenderIndexOptions = {}): string {
  interface Row {
    readonly path: string;
    readonly stem: string;
    readonly name: string;
    readonly key: string;
    readonly type: NoteType;
    readonly expired: boolean;
  }
  const rows = new Map<string, Row>();
  const nameCount = new Map<string, number>();
  for (const entry of entries) {
    const path = normalizeNfc(entry.path);
    if (!isNoteType(entry.type) || isArchivedPath(path) || rows.has(path)) continue;
    const stem = path.replace(/\.md$/i, '');
    const name = stem.slice(stem.lastIndexOf('/') + 1);
    const key = name.toLowerCase();
    nameCount.set(key, (nameCount.get(key) ?? 0) + 1);
    const until = entry.validUntil;
    const expired = isIsoDate(until) && (options.asOf === undefined || until.slice(0, 10) <= options.asOf);
    rows.set(path, { path, stem, name, key, type: entry.type, expired });
  }

  const groups = new Map<string, Row[]>();
  for (const row of rows.values()) {
    const slash = row.path.indexOf('/');
    const group = slash === -1 ? ROOT_GROUP : row.path.slice(0, slash);
    const list = groups.get(group);
    if (list === undefined) groups.set(group, [row]);
    else list.push(row);
  }
  const preferred = (options.groupOrder ?? []).map((dir) => normalizeNfc(dir).split('/')[0] ?? '');
  const rankOf = (group: string): number => {
    const rank = preferred.indexOf(group);
    return rank === -1 ? preferred.length : rank;
  };
  const names = [...groups.keys()].sort((a, b) => rankOf(a) - rankOf(b) || compare(a, b));

  let out = '# Índice\n\nCatálogo gerado. Não edite à mão.\n';
  for (const group of names) {
    out += `\n## ${group}\n`;
    const list = (groups.get(group) ?? []).sort(
      (a, b) =>
        NOTE_TYPES.indexOf(a.type) - NOTE_TYPES.indexOf(b.type) || compare(a.key, b.key) || compare(a.path, b.path),
    );
    for (const row of list) {
      const link = (nameCount.get(row.key) ?? 0) > 1 ? row.stem : row.name;
      out += `- [[${link}]] · ${row.type}${row.expired ? ` (${EXPIRED_LABEL[row.type]})` : ''}\n`;
    }
  }
  return out;
}

/**
 * Lê todas as notas do disco e devolve as entradas do catálogo. Serve para o `init` e para os testes; no uso normal
 * quem tem esses dados prontos é o banco local, sem reler 30 mil arquivos.
 */
export async function collectIndexEntries(
  root: string,
  config: Pick<BrainConfig, 'noteDirs' | 'indexMd'>,
): Promise<IndexEntry[]> {
  const entries: IndexEntry[] = [];
  for (const file of await listNoteFiles(root, config)) {
    if (file.archived) continue;
    const { note } = await readNote(root, file.diskPath);
    const until = note.frontmatter.valid_until;
    entries.push({
      path: file.path,
      type: typeof note.frontmatter.type === 'string' ? note.frontmatter.type : null,
      validUntil: typeof until === 'string' ? until : null,
    });
  }
  return entries;
}

/**
 * Grava o catálogo em `config.indexMd`, de forma atômica. Não regrava se o conteúdo já é o mesmo (para não mudar a
 * data do arquivo à toa). Devolve `true` se gravou.
 */
export async function writeIndexMd(
  root: string,
  config: Pick<BrainConfig, 'indexMd'>,
  content: string,
): Promise<boolean> {
  return serializeWrites(root, async () => {
    const target = await resolveVaultPath(root, config.indexMd);
    try {
      if ((await readFile(target, 'utf8')) === content) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await writeFileAtomic(target, content);
    return true;
  });
}

export interface LogEntry {
  /** Ação da linha: `add`, `update`, `archive`, `ingest`... (as mesmas do corpo dos commits). */
  readonly action: WriteResult['action'] | (string & {});
  /** Tipo da nota, quando houver. */
  readonly type?: string | null;
  readonly title: string;
  /** Data da linha: `AAAA-MM-DD` ou um instante (usa a data local). Padrão: hoje. */
  readonly date?: string | Date;
}

const LOG_HEADER = '# Diário\n\n';

/** Linha do diário, sem a quebra final: `- 2026-11-10 · add handoff: Atlas, consumidores`. */
export function formatLogLine(entry: LogEntry): string {
  const date = typeof entry.date === 'string' ? entry.date : localDate(entry.date);
  const change = formatChangeLine({
    action: entry.action as Parameters<typeof formatChangeLine>[0]['action'],
    ...(entry.type ? { noteType: entry.type } : {}),
    title: entry.title,
  });
  return `- ${date} · ${change.replace(/\s*[\r\n]+\s*/g, ' ')}`;
}

/**
 * Acrescenta uma linha ao fim do `log.md` (cria o arquivo, com o título, se não existir). Nunca altera as linhas
 * que já estão lá. A gravação é atômica e condicional: se outro processo acrescentar ao mesmo tempo, relê e tenta
 * de novo, então nenhuma linha se perde. Devolve a linha gravada.
 */
export async function appendLogLine(root: string, entry: LogEntry): Promise<string> {
  return serializeWrites(root, async () => {
    const line = formatLogLine(entry);
    const target = await resolveVaultPath(root, LOG_MD);
    for (let attempt = 0; ; attempt++) {
      const stamp = await fileStamp(target);
      let current: string | null = null;
      if (stamp !== null) {
        try {
          current = await readFile(target, 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      const eol = current?.includes('\r\n') ? '\r\n' : '\n';
      const base =
        current === null ? LOG_HEADER : current === '' || current.endsWith('\n') ? current : `${current}${eol}`;
      try {
        await writeFileAtomic(target, `${base}${line}${eol}`, { ifUnchangedSince: current === null ? null : stamp });
        return line;
      } catch (error) {
        if (!(error instanceof FileChangedError) || attempt >= 20) throw error;
      }
    }
  });
}
