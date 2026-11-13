// Menções sem link (doc 06, "De onde vêm as arestas": `mention`): o título ou um apelido (`aliases`) de outra nota
// citado no texto sem `[[...]]`. Sem LLM: um dicionário de nomes casado palavra a palavra, como no spike 12
// (precisão de 0,94 lá). As arestas `mention` vão para a tabela `edges` e aparecem no `graph`; o `lint` (marco 4)
// vai sugerir transformá-las em links. Elas NÃO entram no bloco `related` da busca (ver `db/graph.ts`).
//
// O que segura a precisão:
// - palavra inteira, sem diferenciar maiúsculas nem acentos (`nameKey`), e o que separa as palavras no texto tem de
//   ser espaço ou o mesmo separador do título (`Reunião 2026-05-03` não casa com `reunião, 2026`); colado a `_`,
//   `/`, `\` ou `@` não conta (`sqs_fila`, `filas/SQS`, `ana@sqs`);
// - o nome mais longo vence e não há sobreposição (`Mensageria no Projeto Atlas` não vira também `Projeto Atlas`);
// - fora do dicionário: nomes com menos de `MENTION_MIN_CHARS` letras e dígitos, com mais de `MENTION_MAX_WORDS`
//   palavras, só de números, uma palavra só que é palavra vazia ou genérica demais, e nomes de mais de uma nota
//   (ambíguos);
// - fora do texto: código (cercado e na linha), wikilinks, o endereço dos links Markdown, URLs e comentários HTML;
// - a própria nota não menciona a si mesma, e uma nota que já tem um link explícito para outra não ganha também a
//   menção (já está ligada);
// - cópias de conflito e notas arquivadas não entram, nem como origem nem como destino; um fato pode mencionar
//   (o corpo dele é prosa), mas não é destino (o título dele é derivado: "Projeto Atlas led_by Ana Prado").
//
// A varredura é incremental: o dicionário em uso fica em `mention_keys`; a cada varredura só são reprocessadas as
// notas que mudaram e as que contêm (pela busca FTS) um nome que entrou, saiu ou mudou de dono.

import { aliasesOf } from '../vault/index.ts';
import type { DatabaseSync } from './sqlite.ts';

/** Letras e dígitos mínimos de um nome no dicionário (`SQS` entra; `TI` e `Go` não). */
export const MENTION_MIN_CHARS = 3;
/** Palavras máximas de um nome no dicionário: títulos longos não são citados ao pé da letra. */
export const MENTION_MAX_WORDS = 8;
/** Menções gravadas no máximo por nota (destinos distintos). */
export const MAX_MENTIONS_PER_NOTE = 200;
/**
 * Acima destes números de nomes alterados numa varredura, ou de notas a reprocessar, todas as notas são
 * reprocessadas de uma vez (é mais barato que uma busca FTS por nome).
 */
const FULL_RECOMPUTE_KEYS = 300;

/**
 * Palavras que, sozinhas, não servem de nome para menção: palavras vazias e substantivos genéricos demais que viram
 * título de nota com frequência ("Ideias", "Teste", "Projeto"). Sem acento (a comparação é sem acento).
 */
const COMMON_WORDS = new Set(
  `a o as os um uma uns umas de do da dos das em no na nos nas por pelo pela para pra com sem sob sobre ate entre que
  e ou se ao aos como mais mas nao sim ja so tambem muito pouco porque qual quais quando onde quem isso isto esse essa
  este esta ele ela eles elas eu voce nos meu minha seu sua ser sao era foi ter tem estar ha vai the an of to in on at
  by for from with and or but not no yes is are was were be it its this that these those there here what which who
  when where why how all any can will may new old nota notas note notes ideia ideias idea ideas teste testes test
  tests todo todos tarefa tarefas task tasks projeto projetos project projects sistema system dados data hoje ontem
  amanha today dia dias day days semana mes ano year geral general outros other misc inbox rascunho draft resumo
  summary leitura leituras reading pessoa pessoas people time team trabalho work casa home vida life lista list`
    .split(/\s+/)
    .filter((word) => word !== ''),
);

/** Caracteres que, colados a um nome, indicam identificador, caminho ou endereço. */
const IDENTIFIER_GLUE = new Set(['_', '/', '\\', '@']);

const stripMarks = (text: string): string => text.normalize('NFD').replace(/\p{M}+/gu, '');
const TOKEN_RE = /[\p{L}\p{N}]+/gu;

interface Token {
  /** Minúsculas, sem acento. */
  readonly norm: string;
  readonly start: number;
  readonly end: number;
}

/** Palavras de um texto (letras e dígitos), normalizadas, com a posição no texto original. */
function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const match of text.matchAll(TOKEN_RE)) {
    const start = match.index;
    out.push({ norm: stripMarks(match[0]).toLowerCase(), start, end: start + match[0].length });
  }
  return out;
}

/**
 * Chave de um nome: as palavras em minúsculas, sem acento, separadas por um espaço. `Projeto  Atlas`, `projeto
 * atlas` e `PROJETO ATLAS` têm a mesma chave; `Idempotência` e `idempotencia` também. É a chave da tabela `names`
 * e da resolução de uma nota pelo título.
 */
export function nameKey(text: string): string {
  return tokenize(text.normalize('NFC'))
    .map((token) => token.norm)
    .join(' ');
}

/** Separador normalizado entre duas palavras: espaço em branco de qualquer tamanho vira um espaço só. */
const normalizeGap = (gap: string): string => (/^\s+$/.test(gap) ? ' ' : stripMarks(gap).toLowerCase());

/** Troca por espaços (mantendo as quebras de linha e o tamanho) o que não é prosa: código, links, URLs, HTML. */
export function blankNonProse(text: string): string {
  const blank = (match: string): string => match.replace(/[^\n]/g, ' ');
  const lines = text.split('\n');
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
    if (fence === null && marker !== null) {
      fence = marker;
      lines[i] = blank(line);
    } else if (fence !== null) {
      if (marker !== null && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      lines[i] = blank(line);
    }
  }
  return lines
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(`+)[^`\n]+?\1/g, blank)
    .replace(/!?\[\[[^\]\n]*\]\]/g, blank)
    .replace(/\]\([^)\n]*\)/g, blank)
    .replace(/\b(?:https?|ftp|file|mailto):[^\s)>\]]+/gi, blank)
    .replace(/<[^>\n]+>/g, blank);
}

/** Um nome do dicionário. */
export interface MentionEntry {
  readonly key: string;
  readonly noteId: string;
  /** Nome como está na nota (título ou apelido), para mostrar. */
  readonly name: string;
  readonly words: readonly string[];
  /** Separadores normalizados entre as palavras do nome (`words.length - 1` itens). */
  readonly gaps: readonly string[];
}

export interface MentionDictionary {
  readonly entries: ReadonlyMap<string, MentionEntry>;
  /** Primeira palavra → tamanhos (em palavras) dos nomes que começam por ela, do maior para o menor. */
  readonly byFirstWord: ReadonlyMap<string, readonly number[]>;
}

/** Um nome candidato ao dicionário (linha de `names` com o que importa da nota). */
export interface NameCandidate {
  readonly noteId: string;
  readonly name: string;
  readonly kind: 'title' | 'alias';
  readonly noteType: string | null;
  readonly archived: boolean;
  readonly conflictCopy: boolean;
}

/** Por que um nome fica fora do dicionário, ou `null` se ele serve. Exportada para teste. */
export function nameProblem(name: string): 'short' | 'long' | 'numeric' | 'common' | null {
  const words = tokenize(name.normalize('NFC')).map((token) => token.norm);
  const chars = words.join('').length;
  if (chars < MENTION_MIN_CHARS) return 'short';
  if (words.length > MENTION_MAX_WORDS) return 'long';
  if (words.every((word) => /^\p{N}+$/u.test(word))) return 'numeric';
  if (words.length === 1 && COMMON_WORDS.has(words[0] ?? '')) return 'common';
  return null;
}

function entryOf(noteId: string, name: string): MentionEntry {
  const text = name.normalize('NFC');
  const tokens = tokenize(text);
  const gaps: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    gaps.push(normalizeGap(text.slice((tokens[i - 1] as Token).end, (tokens[i] as Token).start)));
  }
  return {
    key: tokens.map((token) => token.norm).join(' '),
    noteId,
    name: name.trim(),
    words: tokens.map((t) => t.norm),
    gaps,
  };
}

/**
 * Monta o dicionário: um nome por chave, só se a chave for de UMA nota (um nome de duas notas é ambíguo e fica de
 * fora) e passar em `nameProblem`. O título tem preferência sobre o apelido para o nome mostrado.
 */
export function buildMentionDictionary(candidates: Iterable<NameCandidate>): MentionDictionary {
  const byKey = new Map<string, { notes: Set<string>; entry: MentionEntry; kind: 'title' | 'alias' }>();
  for (const candidate of candidates) {
    if (candidate.archived || candidate.conflictCopy || candidate.noteType === 'fact') continue;
    if (nameProblem(candidate.name) !== null) continue;
    const entry = entryOf(candidate.noteId, candidate.name);
    if (entry.key === '') continue;
    const known = byKey.get(entry.key);
    if (known === undefined) byKey.set(entry.key, { notes: new Set([candidate.noteId]), entry, kind: candidate.kind });
    else {
      known.notes.add(candidate.noteId);
      if (known.kind === 'alias' && candidate.kind === 'title' && known.entry.noteId === candidate.noteId) {
        known.entry = entry;
        known.kind = 'title';
      }
    }
  }
  const entries = new Map<string, MentionEntry>();
  const lengths = new Map<string, Set<number>>();
  for (const [key, { notes, entry }] of byKey) {
    if (notes.size !== 1) continue;
    entries.set(key, entry);
    const first = entry.words[0] ?? '';
    const set = lengths.get(first) ?? new Set<number>();
    set.add(entry.words.length);
    lengths.set(first, set);
  }
  const byFirstWord = new Map<string, number[]>();
  for (const [word, set] of lengths)
    byFirstWord.set(
      word,
      [...set].sort((a, b) => b - a),
    );
  return { entries, byFirstWord };
}

export interface MentionHit {
  readonly entry: MentionEntry;
  /** Posição (unidades UTF-16) do começo da menção no texto. */
  readonly offset: number;
}

/**
 * Menções em `text` (o texto já passado por `blankNonProse`, ou não), da esquerda para a direita, sem sobreposição
 * e com o nome mais longo primeiro.
 */
export function findMentions(text: string, dictionary: MentionDictionary): MentionHit[] {
  const source = text.normalize('NFC');
  const tokens = tokenize(source);
  const hits: MentionHit[] = [];
  for (let i = 0; i < tokens.length; ) {
    const first = tokens[i] as Token;
    let matched = 0;
    for (const size of dictionary.byFirstWord.get(first.norm) ?? []) {
      if (i + size > tokens.length) continue;
      const words = tokens.slice(i, i + size);
      const entry = dictionary.entries.get(words.map((token) => token.norm).join(' '));
      if (entry === undefined) continue;
      let gapsOk = true;
      for (let j = 1; j < size && gapsOk; j++) {
        const gap = source.slice((words[j - 1] as Token).end, (words[j] as Token).start);
        // no máximo uma quebra de linha no meio de um nome; senão, o separador do próprio título
        gapsOk = /^[ \t]*\r?\n?[ \t]*$/.test(gap) && gap !== '' ? true : normalizeGap(gap) === entry.gaps[j - 1];
      }
      if (!gapsOk) continue;
      // colado a `_`, `/`, `\` ou `@` é pedaço de identificador, caminho ou endereço, não prosa
      const before = source[first.start - 1] ?? ' ';
      const after = source[(words[size - 1] as Token).end] ?? ' ';
      if (IDENTIFIER_GLUE.has(before) || IDENTIFIER_GLUE.has(after)) continue;
      hits.push({ entry, offset: first.start });
      matched = size;
      break;
    }
    i += matched > 0 ? matched : 1;
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------------------------
// Banco

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** Executa `fn` em lotes de até 500 itens (limite de parâmetros do SQLite folgado). */
function inBatches<T>(items: readonly T[], fn: (batch: readonly T[]) => void): void {
  for (let i = 0; i < items.length; i += 500) fn(items.slice(i, i + 500));
}

function parseObject(json: unknown): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(String(json));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Refaz as linhas de `names` (título e `aliases`) das notas `noteIds`. */
export function refreshNames(db: DatabaseSync, noteIds: Iterable<string>): void {
  const ids = [...new Set(noteIds)];
  if (ids.length === 0) return;
  const insert = db.prepare('insert into names(note_id, name, key, kind) values (?, ?, ?, ?)');
  inBatches(ids, (batch) => {
    db.prepare(`delete from names where note_id in (${placeholders(batch.length)})`).run(...batch);
    const rows = db
      .prepare(`select id, title, frontmatter from notes where id in (${placeholders(batch.length)})`)
      .all(...batch);
    for (const row of rows) {
      const id = String(row.id);
      const seen = new Set<string>();
      const add = (name: string, kind: 'title' | 'alias'): void => {
        const key = nameKey(name);
        if (key === '' || seen.has(key)) return;
        seen.add(key);
        insert.run(id, name.trim(), key, kind);
      };
      if (row.title !== null && row.title !== undefined) add(String(row.title), 'title');
      for (const alias of aliasesOf(parseObject(row.frontmatter))) add(alias, 'alias');
    }
  });
}

/** Dicionário a partir da tabela `names`. */
export function loadMentionDictionary(db: DatabaseSync): MentionDictionary {
  const rows = db
    .prepare(
      `select nm.note_id, nm.name, nm.kind, n.type, n.archived, n.conflict_of
       from names nm join notes n on n.id = nm.note_id order by nm.note_id, nm.kind desc, nm.rowid`,
    )
    .all();
  return buildMentionDictionary(
    rows.map((row) => ({
      noteId: String(row.note_id),
      name: String(row.name),
      kind: row.kind === 'alias' ? 'alias' : 'title',
      noteType: row.type === null ? null : String(row.type),
      archived: Number(row.archived) === 1,
      conflictCopy: row.conflict_of !== null,
    })),
  );
}

/** Notas cujo texto contém a frase `key` (palavras na ordem), pela busca FTS: candidatas a reprocessar. */
function notesContaining(db: DatabaseSync, key: string): string[] {
  const phrase = key
    .split(' ')
    .filter((word) => word !== '')
    .map((word) => word.replaceAll('"', '""'))
    .join(' ');
  if (phrase === '') return [];
  try {
    return db
      .prepare(
        `select distinct c.note_id from chunks_fts join chunks c on c.id = chunks_fts.rowid where chunks_fts match ?`,
      )
      .all(`text : "${phrase}"`)
      .map((row) => String(row.note_id));
  } catch {
    return []; // frase que o FTS não aceita: a nota será vista quando mudar
  }
}

export interface MentionRefreshInput {
  /** Notas gravadas ou movidas nesta varredura. */
  readonly touched: ReadonlySet<string>;
  /** Notas cujos links explícitos mudaram de destino (a menção some quando já há link, e volta quando não há). */
  readonly relinked?: ReadonlySet<string>;
}

export interface MentionRefreshSummary {
  /** Notas reprocessadas. */
  readonly notes: number;
  /** Arestas `mention` gravadas nesta passada. */
  readonly edges: number;
  /** Nomes no dicionário em uso. */
  readonly dictionary: number;
  /** Todas as notas foram reprocessadas. */
  readonly full: boolean;
}

/**
 * Atualiza `names`, o dicionário e as arestas `mention`. Chamar dentro da transação da varredura, depois de resolver
 * as arestas explícitas.
 */
export function refreshMentions(db: DatabaseSync, input: MentionRefreshInput): MentionRefreshSummary {
  refreshNames(db, input.touched);
  const dictionary = loadMentionDictionary(db);

  const previous = new Map<string, string>();
  for (const row of db.prepare('select key, note_id from mention_keys').all()) {
    previous.set(String(row.key), String(row.note_id));
  }
  const changedKeys: string[] = [];
  for (const [key, noteId] of previous) if (dictionary.entries.get(key)?.noteId !== noteId) changedKeys.push(key);
  for (const [key, entry] of dictionary.entries) if (previous.get(key) !== entry.noteId) changedKeys.push(key);
  const changed = [...new Set(changedKeys)];

  const eligible = new Set(
    db
      .prepare('select id from notes where archived = 0 and conflict_of is null')
      .all()
      .map((row) => String(row.id)),
  );
  let full = changed.length > FULL_RECOMPUTE_KEYS;
  const redo = new Set<string>();
  if (full) for (const id of eligible) redo.add(id);
  else {
    for (const id of input.touched) redo.add(id);
    for (const id of input.relinked ?? []) redo.add(id);
    for (const key of changed) for (const id of notesContaining(db, key)) redo.add(id);
    if (redo.size >= eligible.size && eligible.size > 0) full = true;
  }

  // apaga as menções que podem ter mudado: das notas a refazer, dos nomes que mudaram e as que perderam o destino
  if (full) db.exec(`delete from edges where origin = 'mention'`);
  else {
    db.exec(`delete from edges where origin = 'mention' and dst_note is null`);
    inBatches([...redo], (batch) =>
      db
        .prepare(`delete from edges where origin = 'mention' and src_note in (${placeholders(batch.length)})`)
        .run(...batch),
    );
    inBatches(changed, (batch) =>
      db
        .prepare(`delete from edges where origin = 'mention' and target_key in (${placeholders(batch.length)})`)
        .run(...batch),
    );
  }

  const chunks = db.prepare('select text, start_line from chunks where note_id = ? order by ord');
  const linked = db.prepare(
    `select distinct dst_note from edges where src_note = ? and origin <> 'mention' and dst_note is not null`,
  );
  const validity = db.prepare('select valid_from, valid_until from notes where id = ?');
  const insert = db.prepare(`insert into edges(src_note, dst_note, type, origin, target, target_key, anchor, alias,
    line, valid_from, valid_until) values (?, ?, 'mention', 'mention', ?, ?, null, null, ?, ?, ?)`);
  let edges = 0;
  let notes = 0;
  for (const noteId of [...redo].sort()) {
    if (!eligible.has(noteId)) continue;
    notes++;
    const skip = new Set(linked.all(noteId).map((row) => String(row.dst_note)));
    skip.add(noteId);
    const dates = validity.get(noteId);
    const seen = new Set<string>();
    for (const chunk of chunks.all(noteId)) {
      if (seen.size >= MAX_MENTIONS_PER_NOTE) break;
      const text = blankNonProse(String(chunk.text));
      for (const hit of findMentions(text, dictionary)) {
        const target = hit.entry.noteId;
        if (skip.has(target) || seen.has(target)) continue;
        seen.add(target);
        const startLine = chunk.start_line === null ? null : Number(chunk.start_line);
        const line = startLine === null ? null : startLine + (text.slice(0, hit.offset).match(/\n/g)?.length ?? 0);
        insert.run(
          noteId,
          target,
          hit.entry.name,
          hit.entry.key,
          line,
          dates?.valid_from ?? null,
          dates?.valid_until ?? null,
        );
        edges++;
        if (seen.size >= MAX_MENTIONS_PER_NOTE) break;
      }
    }
  }

  // o dicionário em uso passa a ser este
  if (changed.length > 0) {
    const del = db.prepare('delete from mention_keys where key = ?');
    const put = db.prepare('insert into mention_keys(key, note_id, name) values (?, ?, ?)');
    for (const key of changed) {
      del.run(key);
      const entry = dictionary.entries.get(key);
      if (entry !== undefined) put.run(key, entry.noteId, entry.name);
    }
  }
  return { notes, edges, dictionary: dictionary.entries.size, full };
}
