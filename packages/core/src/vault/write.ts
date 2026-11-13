// Escrita de notas: criar, alterar, substituir trecho, relacionar e arquivar. Sempre atômica e sempre dentro do cérebro.
// O vault NÃO faz commit, NÃO roda o scanner de segredos e NÃO toca no banco: isso é da camada de operações, que
// também é quem segura a trava entre processos (`withLock`) quando precisa.
import { readdir, unlink } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type { CommitChange } from '../git/index.ts';
import { normalizeLinkTarget, splitFrontmatter } from '../markdown/index.ts';
import type { FileStamp } from '../util/index.ts';
import { FileChangedError, fileStamp, ulid, writeFileAtomic } from '../util/index.ts';
import type { BrainConfig } from './config.ts';
import { readBrainConfig } from './config.ts';
import { VaultError } from './errors.ts';
import {
  dirNameProblem,
  FILE_NAME_STYLES,
  fileNameKey,
  fileNameProblem,
  noteBaseName,
  uniqueFileName,
} from './filename.ts';
import { listNoteFiles } from './list.ts';
import {
  assertNotePath,
  CLIENT_INSTRUCTION_FILES,
  diskCasePath,
  isBrainControlFile,
  isInNoteDirs,
  resolveVaultPath,
} from './paths.ts';
import { serializeWrites } from './queue.ts';
import type { NoteRead } from './read.ts';
import { readNote } from './read.ts';
import type { LinkIndex } from './resolve.ts';
import { buildLinkIndex } from './resolve.ts';
import type { NoteIssue, NoteType, RelationsConfig } from './schema.ts';
import {
  ARCHIVE_DIR,
  defaultTrustForOrigin,
  displayTitle,
  hasErrors,
  isArchivedPath,
  isIsoDate,
  isNoteType,
  isValidOrigin,
  isWikilinkText,
  linkListFields,
  noteDirForType,
  validateNote,
} from './schema.ts';
import { editFrontmatterText, serializeFrontmatter, serializeNote } from './serialize.ts';

export type WriteAction = 'add' | 'update' | 'archive';

/** O que uma escrita mudou; é com isto que o chamador monta o commit e a linha do diário. */
export interface WriteResult {
  readonly action: WriteAction;
  /** Caminho da nota depois da escrita (relativo, com `/`, NFC). */
  readonly path: string;
  /** Em `archive`: onde a nota estava. */
  readonly from?: string;
  /** Tipo da nota; `null` numa nota sem `type` (fonte bruta, nota não gerenciada). */
  readonly type: NoteType | null;
  readonly title: string;
  readonly id: string | null;
  /** `false` quando a operação era idempotente e o arquivo já estava como pedido (nada foi gravado). */
  readonly changed: boolean;
  /** Carimbo do arquivo depois da escrita. */
  readonly stamp: FileStamp;
  /** Avisos da validação (os erros impedem a escrita). */
  readonly warnings: readonly NoteIssue[];
}

/** Converte o resultado de uma escrita na linha de mudança do commit (`add gotcha: título`). */
export function toCommitChange(result: Pick<WriteResult, 'action' | 'type' | 'title'>): CommitChange {
  return result.type === null
    ? { action: result.action, title: result.title }
    : { action: result.action, noteType: result.type, title: result.title };
}

/** Data local `AAAA-MM-DD`: é o "hoje" de quem está usando a máquina, como nas datas que o Obsidian grava. */
export function localDate(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(now.getFullYear()).padStart(4, '0')}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const present = (value: unknown): boolean => value !== undefined && value !== null && value !== '';
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const dirName = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const stemOf = (name: string): string => name.replace(/\.md$/i, '');

function resultOf(
  action: WriteAction,
  path: string,
  frontmatter: Readonly<Record<string, unknown>>,
  changed: boolean,
  stamp: FileStamp,
  issues: readonly NoteIssue[],
  from?: string,
): WriteResult {
  return {
    action,
    path,
    ...(from === undefined ? {} : { from }),
    type: isNoteType(frontmatter.type) ? frontmatter.type : null,
    title: displayTitle(frontmatter, path),
    id: typeof frontmatter.id === 'string' && frontmatter.id !== '' ? frontmatter.id : null,
    changed,
    stamp,
    warnings: issues.filter((issue) => issue.severity === 'warning'),
  };
}

function invalid(path: string, issues: readonly NoteIssue[]): VaultError {
  const errors = issues.filter((issue) => issue.severity === 'error');
  return new VaultError('invalid_note', `nota inválida (${path}): ${errors.map((issue) => issue.message).join('; ')}`, {
    path,
    issues,
  });
}

/**
 * O que uma escrita pretende que o arquivo signifique: o frontmatter (`null` = arquivo sem bloco de frontmatter) e o
 * corpo. Com `raw`, o bloco de frontmatter foi mantido como estava (YAML que não se lê), e é ele que tem de voltar.
 */
interface IntendedNote {
  readonly frontmatter: Readonly<Record<string, unknown>> | null;
  readonly raw?: string;
  readonly body: string;
}

/**
 * Confere, ANTES de gravar, que o texto montado é lido pelo parser do Cabeção (`splitFrontmatter`, o mesmo da leitura,
 * do banco e do catálogo) exatamente como a escrita pretende: o mesmo frontmatter (mesmas chaves e valores) e o mesmo
 * corpo. Qualquer diferença entre "o que a escrita acha que gravou" e "o que será lido" é recusada
 * (`frontmatter_mismatch`): um corpo que abre com BOM ou com `---` e vira frontmatter numa nota que não tinha, um
 * campo cujo YAML significa outra coisa (chave com espaço, `<<`), um trecho de `patch` que cria ou atravessa o
 * delimitador. Vale para toda escrita do vault, de agente ou do usuário.
 */
function assertReadsBack(path: string, text: string, intended: IntendedNote): void {
  const parsed = splitFrontmatter(text);
  let same = parsed.body === intended.body;
  if (intended.frontmatter === null) {
    same &&= !parsed.hasFrontmatter;
  } else if (intended.raw !== undefined) {
    same &&= parsed.hasFrontmatter && parsed.raw === intended.raw;
  } else {
    same &&= parsed.hasFrontmatter && parsed.error === null && isDeepStrictEqual(parsed.data, intended.frontmatter);
  }
  if (!same) {
    throw new VaultError(
      'frontmatter_mismatch',
      `o texto de ${path} seria lido de outro jeito do que a escrita pede (o frontmatter ou o corpo mudariam ao ser relidos); nada foi gravado`,
      { path },
    );
  }
}

/** Nomes (como chave, sem `.md`) das notas que já existem numa pasta. Pasta que não existe não tem nenhum. */
async function takenNames(root: string, dir: string): Promise<Set<string>> {
  const taken = new Set<string>();
  try {
    // `dir` vazio: a raiz do cérebro (nota solta num vault adotado com `noteDirs: ["."]`)
    for (const name of await readdir(dir === '' ? root : await resolveVaultPath(root, dir))) {
      if (/\.md$/i.test(name)) taken.add(fileNameKey(stemOf(name)));
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
  }
  return taken;
}

export interface CreateNoteInput {
  readonly type: NoteType;
  /** Quem está criando: `human`, `agent:<cliente>` ou `ingest:<fonte>`. Vai para o campo `origin`. */
  readonly origin: string;
  /** Obrigatório em todos os tipos, menos `fact`. */
  readonly title?: string;
  /** Corpo em Markdown, sem frontmatter. */
  readonly body?: string;
  /**
   * Demais campos: `scope`, `tags`, `sources`, datas de validade, relações tipadas, `subject`/`predicate`/`object`
   * e campos próprios do usuário. `id`, `created` e `updated`, se vierem, são respeitados (importação, migração).
   */
  readonly frontmatter?: Readonly<Record<string, unknown>>;
  /**
   * Caminho exato da nota (`write_page`). Sem ele, a pasta sai do tipo e o nome sai do título. Com ele, a nota
   * não pode existir e o caminho tem de ficar dentro de `noteDirs`.
   */
  readonly path?: string;
  /** Instante da criação (para testes e importações). Padrão: agora. */
  readonly now?: Date;
}

export interface CreateNoteOptions {
  /**
   * Índice de nomes do cérebro inteiro (`buildLinkIndex`), usado para o nome gerado não repetir o de uma nota em
   * OUTRA pasta, o que deixaria `[[nome]]` ambíguo. Sem ele, `createNote` monta um com `listNoteFiles` (só
   * `readdir` e `stat`, sem ler conteúdo); quem já tem o índice pronto (o banco local) passa aqui para poupar a
   * varredura. A pasta de destino é sempre conferida no disco, de qualquer jeito.
   */
  readonly linkIndex?: LinkIndex;
}

/**
 * Cria uma nota: gera `id` (ULID), `created` e `updated`, preenche os padrões (`trust` pela origem, `scope: global`,
 * `tags` e `sources` vazios; num fato, `valid_from`), valida e grava de forma atômica, sem nunca sobrescrever.
 *
 * Pasta: a do tipo (`NOTE_TYPE_DIRS`; episódios em `memory/episodes/AAAA/MM/` pelo `created`). Nome do arquivo,
 * quando `path` não é dado: a regra está no topo de `filename.ts` (título legível para source, concept, entity e
 * synthesis; slug para decision, rule, preference, gotcha, procedure e fact; data + slug para episode e handoff;
 * no máximo 160 bytes; seguro em Windows, macOS e Linux; desempate `Nome 2`/`nome-2` sem diferenciar maiúsculas,
 * contra a pasta de destino e contra os nomes do cérebro inteiro).
 *
 * Lança `VaultError`: `rule_requires_human` (regras só o usuário cria), `invalid_note` (com `issues`),
 * `invalid_note_path`, `invalid_file_name`, `note_exists` ou `unsafe_path`.
 */
export async function createNote(
  root: string,
  config: BrainConfig,
  input: CreateNoteInput,
  options: CreateNoteOptions = {},
): Promise<WriteResult> {
  return serializeWrites(root, async () => {
    if (!isNoteType(input.type)) {
      throw new VaultError('invalid_note', `tipo de nota desconhecido: ${JSON.stringify(input.type)}`);
    }
    if (!isValidOrigin(input.origin)) {
      throw new VaultError(
        'invalid_note',
        `origem inválida (${JSON.stringify(input.origin)}): use "human", "agent:<cliente>" ou "ingest:<fonte>"`,
      );
    }
    if (input.type === 'rule' && input.origin !== 'human') {
      throw new VaultError(
        'rule_requires_human',
        'regras (type: rule) só o usuário cria; um agente não pode gravá-las',
      );
    }

    const now = input.now ?? new Date();
    const today = localDate(now);
    const extra = Object.fromEntries(
      Object.entries(input.frontmatter ?? {}).filter(([, value]) => value !== undefined),
    );
    const frontmatter: Record<string, unknown> = { ...extra };
    if (!present(frontmatter.id)) frontmatter.id = ulid(now.getTime());
    frontmatter.type = input.type;
    const title = input.title ?? extra.title;
    if (present(title)) frontmatter.title = typeof title === 'string' ? title.trim() : title;
    else delete frontmatter.title;
    frontmatter.origin = input.origin;
    if (!present(frontmatter.trust)) frontmatter.trust = defaultTrustForOrigin(input.origin);
    if (!present(frontmatter.created)) frontmatter.created = today;
    if (!present(frontmatter.updated)) frontmatter.updated = today;
    if (input.type === 'fact') {
      if (!present(frontmatter.valid_from)) frontmatter.valid_from = frontmatter.created;
    } else {
      if (!present(frontmatter.scope)) frontmatter.scope = 'global';
      frontmatter.tags ??= [];
      frontmatter.sources ??= [];
    }

    const issues = validateNote({ frontmatter }, config);
    if (hasErrors(issues)) throw invalid(input.path ?? `nova nota do tipo ${input.type}`, issues);

    const text = serializeNote(frontmatter, input.body ?? '', config);
    const yaml = serializeFrontmatter(frontmatter, config);
    const headerLength = yaml === '' ? 0 : `---\n${yaml}---\n`.length;
    assertReadsBack(input.path ?? `nova nota do tipo ${input.type}`, text, {
      frontmatter: yaml === '' ? null : frontmatter,
      body: text.slice(headerLength),
    });
    const write = async (path: string): Promise<FileStamp | null> => {
      try {
        return await writeFileAtomic(await resolveVaultPath(root, path, { write: true }), text, {
          ifUnchangedSince: null,
        });
      } catch (error) {
        if (error instanceof FileChangedError) return null;
        throw error;
      }
    };

    if (input.path !== undefined) {
      // a grafia do disco: `WIKI/Entities/x.md` cai em `wiki/entities/x.md` quando essas pastas já existem
      const { path, existing } = await diskCasePath(root, assertNotePath(input.path));
      if (!isInNoteDirs(path, config)) {
        throw new VaultError(
          'invalid_note_path',
          `${path} fica fora das pastas de notas do cérebro (${config.noteDirs.join(', ')})`,
          { path },
        );
      }
      assertNotControlFile(path, config);
      const segments = path.split('/');
      for (const [i, segment] of segments.slice(0, -1).entries()) {
        const problem = dirNameProblem(segment, { existing: i < existing });
        if (problem !== null) {
          throw new VaultError('invalid_file_name', `pasta recusada (${path}): ${problem}`, { path });
        }
      }
      const problem = fileNameProblem(baseName(path));
      if (problem !== null)
        throw new VaultError('invalid_file_name', `nome de arquivo recusado (${path}): ${problem}`, { path });
      const exists = (await takenNames(root, dirName(path))).has(fileNameKey(stemOf(baseName(path))));
      const stamp = exists ? null : await write(path);
      if (stamp === null) throw new VaultError('note_exists', `já existe uma nota em ${path}`, { path });
      return resultOf('add', path, frontmatter, true, stamp, issues);
    }

    const dir = noteDirForType(input.type, String(frontmatter.created));
    if (!isInNoteDirs(`${dir}/x.md`, config)) {
      throw new VaultError(
        'invalid_note_path',
        `a pasta padrão do tipo ${input.type} (${dir}) fica fora das pastas de notas do cérebro (${config.noteDirs.join(', ')}); informe o caminho da nota`,
        { path: dir },
      );
    }
    const base = noteBaseName({
      type: input.type,
      title: displayTitle(frontmatter),
      date: String(frontmatter.created),
      fallback: String(frontmatter.id),
    });
    const taken = await takenNames(root, dir);
    const linkIndex = options.linkIndex ?? buildLinkIndex(await listNoteFiles(root, config));
    const separator = FILE_NAME_STYLES[input.type] === 'title' ? ' ' : '-';
    for (let attempt = 0; attempt < 50; attempt++) {
      // um nome gerado nunca é o de um arquivo de instrução de cliente de IA (`Claude.md` viraria instrução)
      const name = uniqueFileName(
        base,
        (key) => taken.has(key) || linkIndex.byName.has(key) || CLIENT_INSTRUCTION_FILES.includes(`${key}.md`),
        separator,
      );
      const path = `${dir}/${name}`;
      const stamp = await write(path);
      if (stamp !== null) return resultOf('add', path, frontmatter, true, stamp, issues);
      // outro processo criou o mesmo nome entre a listagem e a gravação: tenta o próximo
      taken.add(fileNameKey(stemOf(name)));
    }
    throw new VaultError('note_exists', `não consegui um nome livre em ${dir} para "${base}"`, { path: dir });
  });
}

/** Recusa gravar como nota um arquivo de controle do cérebro (`AGENTS.md`, `CLAUDE.md`, `index.md`, `log.md`...). */
function assertNotControlFile(path: string, config: unknown): void {
  const indexMd = (config as { indexMd?: unknown } | undefined)?.indexMd;
  if (isBrainControlFile(path, typeof indexMd === 'string' ? { indexMd } : {})) {
    throw new VaultError(
      'invalid_note_path',
      `${path} é um arquivo de controle do cérebro (instruções, catálogo ou diário), não uma nota; ele não é gravado por aqui`,
      { path },
    );
  }
}

export interface NoteChanges {
  /** Campos a gravar. `null` grava o campo vazio (`valid_until:`); `undefined` não mexe. */
  readonly frontmatter?: Readonly<Record<string, unknown>>;
  /** Campos a remover do frontmatter. */
  readonly remove?: readonly string[];
  /** Corpo novo, inteiro. Ausente: o corpo fica byte a byte como está. */
  readonly body?: string;
}

export interface UpdateNoteOptions {
  /**
   * Carimbo de quando o chamador leu a nota (`NoteRead.stamp`). Se o arquivo mudou desde então (edição no Obsidian,
   * outro agente), a escrita é recusada com `FileChangedError`. Mesmo sem isto, a escrita confere que o arquivo não
   * mudou entre a leitura e a gravação feitas aqui dentro.
   */
  readonly ifUnchangedSince?: FileStamp;
  /**
   * Relações extras do `.cabecao.json`, para validar e ordenar os campos (um `BrainConfig` serve). Sem isto, o
   * `.cabecao.json` da raiz é lido; se ele não existir, valem só as relações fixas.
   */
  readonly config?: RelationsConfig;
  /** Instante da alteração (para testes). Padrão: agora. */
  readonly now?: Date;
  /** `false` para não atualizar o campo `updated` (migrações). Padrão: `true`. */
  readonly touch?: boolean;
}

interface Rendered {
  readonly text: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly changed: boolean;
  readonly issues: readonly NoteIssue[];
}

const sameStamp = (a: FileStamp, b: FileStamp): boolean => a.mtimeMs === b.mtimeMs && a.size === b.size;

/** Calcula o novo texto do arquivo. Não toca no disco. */
function render(read: NoteRead, changes: NoteChanges, options: UpdateNoteOptions): Rendered {
  const { note, path } = read;
  const before = note.frontmatter;
  const set = Object.fromEntries(Object.entries(changes.frontmatter ?? {}).filter(([, value]) => value !== undefined));
  const remove = (changes.remove ?? []).filter((key) => key in before && !(key in set));
  const touchesFrontmatter = Object.keys(set).length > 0 || (changes.remove ?? []).length > 0;

  if (note.frontmatterError !== null && touchesFrontmatter) {
    throw new VaultError(
      'invalid_frontmatter',
      `o frontmatter de ${path} não pôde ser lido (${note.frontmatterError.message}); corrija o arquivo antes de alterar os campos`,
      { path },
    );
  }
  for (const field of ['id', 'type']) {
    const changed = field in set ? !isDeepStrictEqual(set[field], before[field]) : remove.includes(field);
    if (changed && present(before[field])) {
      throw new VaultError('immutable_field', `não dá para trocar "${field}" de uma nota existente (${path})`, {
        path,
      });
    }
  }

  const after: Record<string, unknown> = { ...before, ...set };
  for (const key of remove) delete after[key];
  const body = changes.body ?? note.body;
  const bodyChanged = body !== note.body;
  const beforeIssues = validateNote(
    { frontmatter: before, frontmatterError: note.frontmatterError, path },
    options.config,
  );
  if (isDeepStrictEqual(after, before) && !bodyChanged) {
    return { text: read.text, frontmatter: before, changed: false, issues: beforeIssues };
  }
  // só uma nota gerenciada (com `id`) tem `updated`; uma fonte bruta fica como está
  if (options.touch !== false && present(after.id) && !('updated' in set) && note.frontmatterError === null) {
    after.updated = localDate(options.now);
  }

  const issues = validateNote({ frontmatter: after, frontmatterError: note.frontmatterError, path }, options.config);
  // Uma nota que já tinha problema (editada à mão) não fica travada: só é recusado o erro que a mudança introduz.
  const known = new Set(beforeIssues.map((issue) => `${issue.code}\0${issue.field}`));
  const introduced = issues.filter(
    (issue) => issue.severity === 'error' && !known.has(`${issue.code}\0${issue.field}`),
  );
  if (introduced.length > 0) throw invalid(path, introduced);

  const bom = read.text.charCodeAt(0) === 0xfeff ? '\uFEFF' : '';
  const source = bom === '' ? read.text : read.text.slice(1);
  const oldHeader = source.slice(0, source.length - note.body.length);
  const changedKeys = Object.keys(after).filter((key) => !isDeepStrictEqual(after[key], before[key]));
  let header = oldHeader;
  if (changedKeys.length > 0 || remove.length > 0) {
    const eol = oldHeader.includes('\r\n') ? '\r\n' : '\n';
    const edited = note.hasFrontmatter
      ? editFrontmatterText(
          splitFrontmatter(read.text).raw ?? '',
          { set: Object.fromEntries(changedKeys.map((key) => [key, after[key]])), remove },
          options.config,
        )
      : null;
    const yaml = edited ?? serializeFrontmatter(after, options.config).replace(/\n$/, '').replaceAll('\n', eol);
    header = `---${eol}${yaml}${yaml === '' ? '' : eol}---${eol}`;
  }
  let newBody = body;
  if (bodyChanged && newBody !== '' && !newBody.endsWith('\n')) newBody += '\n';
  // sem frontmatter, um corpo que começa com `---` seria lido como frontmatter
  if (header === '' && bodyChanged && /^---[ \t]*\r?\n/.test(newBody)) newBody = `\n${newBody}`;
  const text = `${bom}${header}${newBody}`;
  assertReadsBack(path, text, {
    frontmatter: header === '' ? null : after,
    ...(header !== '' && note.frontmatterError !== null ? { raw: splitFrontmatter(read.text).raw ?? '' } : {}),
    body: newBody,
  });
  return { text, frontmatter: after, changed: true, issues };
}

/** Opções com `config` preenchido: o que veio do chamador ou as relações do `.cabecao.json`. */
async function withConfig(root: string, options: UpdateNoteOptions): Promise<UpdateNoteOptions> {
  if (options.config !== undefined) return options;
  try {
    return { ...options, config: await readBrainConfig(root) };
  } catch (error) {
    if (error instanceof VaultError && error.code === 'config_not_found') return options;
    throw error;
  }
}

async function readForWrite(root: string, relPath: string, options: UpdateNoteOptions): Promise<NoteRead> {
  // a grafia do disco: a escrita e o commit têm de usar o nome que o git conhece (`SQS.md`, não `sqs.md`)
  const { path } = await diskCasePath(root, assertNotePath(relPath));
  assertNotControlFile(path, options.config);
  const read = await readNote(root, path);
  if (options.ifUnchangedSince !== undefined && !sameStamp(options.ifUnchangedSince, read.stamp)) {
    throw new FileChangedError(read.path, options.ifUnchangedSince, read.stamp);
  }
  return read;
}

async function applyUpdate(
  root: string,
  read: NoteRead,
  changes: NoteChanges,
  options: UpdateNoteOptions,
): Promise<WriteResult> {
  const rendered = render(read, changes, options);
  if (!rendered.changed) return resultOf('update', read.path, rendered.frontmatter, false, read.stamp, rendered.issues);
  const stamp = await writeFileAtomic(await resolveVaultPath(root, read.diskPath, { write: true }), rendered.text, {
    ifUnchangedSince: read.stamp,
  });
  return resultOf('update', read.path, rendered.frontmatter, true, stamp, rendered.issues);
}

/**
 * Altera frontmatter e/ou corpo de uma nota existente, preservando o que não foi tocado: no frontmatter, só as
 * linhas dos campos alterados mudam (ordem, comentários e formatação do resto ficam como estão); o corpo, se não
 * for trocado, fica byte a byte igual. Atualiza `updated`. `id` e `type` não podem ser trocados.
 *
 * A gravação usa `ifUnchangedSince`: se o arquivo mudar no meio (edição no Obsidian), lança `FileChangedError` e
 * nada é gravado. Lança `VaultError`: `note_not_found`, `invalid_note` (só para erro que a mudança introduz),
 * `invalid_frontmatter`, `immutable_field`, `unsafe_path` ou `invalid_note_path`.
 */
export async function updateNote(
  root: string,
  relPath: string,
  changes: NoteChanges,
  options: UpdateNoteOptions = {},
): Promise<WriteResult> {
  return serializeWrites(root, async () => {
    const opts = await withConfig(root, options);
    const read = await readForWrite(root, relPath, opts);
    if (changes.body !== undefined && typeof changes.body !== 'string') {
      throw new VaultError('invalid_note', 'o corpo da nota deveria ser um texto', { path: read.path });
    }
    // num arquivo com CRLF (git com autocrlf no Windows), o corpo novo segue a mesma quebra, para não misturar as duas
    const body =
      changes.body !== undefined && read.text.includes('\r\n') ? changes.body.replace(/\r?\n/g, '\r\n') : changes.body;
    return applyUpdate(root, read, body === undefined ? changes : { ...changes, body }, opts);
  });
}

/** Ocorrências de `needle`, contando também as sobrepostas: `aa` aparece 2 vezes em `aaa` (é ambíguo). */
function countOccurrences(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) count++;
  return count;
}

/**
 * Substituição exata e ÚNICA no corpo da nota (o frontmatter não entra na busca). Zero ocorrências ou mais de uma
 * é erro (`patch_not_found`, `patch_ambiguous`), e nada é gravado. Num arquivo com CRLF, um trecho escrito com LF
 * também é achado.
 */
export interface PatchNoteOptions extends UpdateNoteOptions {
  /**
   * Campos do frontmatter a gravar junto com a substituição, no mesmo arquivo e na mesma gravação (a camada de
   * operações usa para registrar a proveniência quando um agente altera uma nota do usuário).
   */
  readonly frontmatter?: Readonly<Record<string, unknown>>;
}

export async function patchNote(
  root: string,
  relPath: string,
  oldText: string,
  newText: string,
  options: PatchNoteOptions = {},
): Promise<WriteResult> {
  return serializeWrites(root, async () => {
    const opts = await withConfig(root, options);
    const read = await readForWrite(root, relPath, opts);
    const path = read.path;
    if (typeof oldText !== 'string' || oldText === '') {
      throw new VaultError('patch_empty', 'o trecho a substituir está vazio', { path });
    }
    if (typeof newText !== 'string') {
      throw new VaultError('invalid_note', 'o trecho novo deveria ser um texto', { path });
    }
    const body = read.note.body;
    let [from, to] = [oldText, newText];
    let occurrences = countOccurrences(body, from);
    if (occurrences === 0 && body.includes('\r\n') && !from.includes('\r')) {
      [from, to] = [from.replaceAll('\n', '\r\n'), to.replace(/\r?\n/g, '\r\n')];
      occurrences = countOccurrences(body, from);
    }
    if (occurrences === 0) {
      throw new VaultError('patch_not_found', `o trecho a substituir não aparece no corpo de ${path}`, { path });
    }
    if (occurrences > 1) {
      throw new VaultError(
        'patch_ambiguous',
        `o trecho a substituir aparece ${occurrences} vezes no corpo de ${path}; inclua mais contexto para ele ser único`,
        { path, occurrences },
      );
    }
    const at = body.indexOf(from);
    const patched = body.slice(0, at) + to + body.slice(at + from.length);
    const frontmatter = options.frontmatter;
    return applyUpdate(
      root,
      read,
      frontmatter === undefined ? { body: patched } : { body: patched, frontmatter },
      opts,
    );
  });
}

const LINK_TARGET_RE = /^\[\[([^[\]\n|#]*)/;

/**
 * Acrescenta uma relação tipada (`uses`, `part_of`... ou `supersedes`/`superseded_by`) no frontmatter. Idempotente:
 * se o alvo já está na lista (sem diferenciar maiúsculas), nada é gravado e `changed` vem `false`.
 * `target` pode ser `Nota`, `pasta/Nota` ou `[[Nota]]`. As relações extras vêm do `.cabecao.json` (ou de `options.config`).
 */
export async function addRelation(
  root: string,
  relPath: string,
  type: string,
  target: string,
  options: UpdateNoteOptions = {},
): Promise<WriteResult> {
  return serializeWrites(root, async () => {
    const opts = await withConfig(root, options);
    const allowed = linkListFields(opts.config);
    if (!allowed.includes(type)) {
      throw new VaultError(
        'unknown_relation',
        `relação desconhecida: ${JSON.stringify(type)}; as relações são: ${allowed.join(', ')}`,
      );
    }
    const trimmed = typeof target === 'string' ? target.trim() : '';
    const link = isWikilinkText(trimmed) ? trimmed : /^[^[\]\n|#]+$/.test(trimmed) ? `[[${trimmed}]]` : null;
    if (link === null) {
      throw new VaultError(
        'invalid_link_target',
        `alvo de relação inválido: ${JSON.stringify(target)}; use o nome da nota`,
      );
    }
    const read = await readForWrite(root, relPath, opts);
    const current = read.note.frontmatter[type];
    if (present(current) && !Array.isArray(current)) {
      throw new VaultError(
        'invalid_note',
        `"${type}" em ${read.path} não é uma lista de wikilinks; corrija o arquivo`,
        {
          path: read.path,
        },
      );
    }
    const list = Array.isArray(current) ? (current as unknown[]) : [];
    const keyOf = (item: unknown): string =>
      normalizeLinkTarget(LINK_TARGET_RE.exec(String(item).trim())?.[1] ?? String(item));
    if (list.some((item) => keyOf(item) === keyOf(link))) return applyUpdate(root, read, {}, opts);
    return applyUpdate(root, read, { frontmatter: { [type]: [...list, link] } }, opts);
  });
}

/**
 * Arquiva uma nota (o `forget` arquiva, não apaga): move para `memory/_archive/` mantendo o nome (com `-2`, `-3`...
 * se já houver um igual lá), atualiza `updated` e, se a nota ainda não tinha, preenche `valid_until` com a data de
 * hoje. A cópia arquivada é gravada antes de a original ser removida; se a original mudar no meio, nada se perde e
 * a operação falha com `FileChangedError`.
 */
export async function archiveNote(
  root: string,
  relPath: string,
  options: UpdateNoteOptions = {},
): Promise<WriteResult> {
  return serializeWrites(root, async () => {
    if (isArchivedPath(assertNotePath(relPath))) {
      throw new VaultError('already_archived', `a nota já está arquivada: ${relPath}`, { path: relPath });
    }
    const opts = await withConfig(root, options);
    const read = await readForWrite(root, relPath, opts);
    const today = localDate(options.now);
    const before = read.note.frontmatter;
    const managed = present(before.id) && read.note.frontmatterError === null;
    const validFrom = before.valid_from;
    const expire = managed && !present(before.valid_until) && !(isIsoDate(validFrom) && validFrom.slice(0, 10) > today);
    const rendered = render(
      read,
      managed ? { frontmatter: { updated: today, ...(expire ? { valid_until: today } : {}) } } : {},
      opts,
    );

    const taken = await takenNames(root, ARCHIVE_DIR);
    const stem = stemOf(baseName(read.path));
    for (let attempt = 0; attempt < 50; attempt++) {
      const name = uniqueFileName(stem, (key) => taken.has(key));
      const path = `${ARCHIVE_DIR}/${name}`;
      const target = await resolveVaultPath(root, path, { write: true });
      let stamp: FileStamp;
      try {
        stamp = await writeFileAtomic(target, rendered.text, { ifUnchangedSince: null });
      } catch (error) {
        if (!(error instanceof FileChangedError)) throw error;
        taken.add(fileNameKey(stemOf(name)));
        continue;
      }
      const source = await resolveVaultPath(root, read.diskPath, { write: true });
      const current = await fileStamp(source);
      if (current === null || !sameStamp(current, read.stamp)) {
        await unlink(target).catch(() => {});
        throw new FileChangedError(read.path, read.stamp, current);
      }
      await unlink(source);
      return resultOf('archive', path, rendered.frontmatter, true, stamp, rendered.issues, read.path);
    }
    throw new VaultError('note_exists', `não consegui um nome livre em ${ARCHIVE_DIR} para "${stem}"`, {
      path: ARCHIVE_DIR,
    });
  });
}
