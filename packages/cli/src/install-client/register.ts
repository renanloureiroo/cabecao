// Registro do servidor MCP nos clientes de IA: o que `install-client` faz e o que o `init` reusa no passo 4.
// O `doctor` usa a leitura (`readRegistrations`), que só lê arquivos e nunca executa o cliente.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { CliError } from '../errors.ts';
import type { CliIo } from '../types.ts';
import type { ClientDef, ClientId, JsonEntry, JsonTarget, Location, Target, TomlTarget } from './clients.ts';
import { CLIENT_IDS, CLIENTS, SERVER_NAME } from './clients.ts';
import { editFile, findExecutable, isDirectory, isFile } from './files.ts';
import type { JsonObjectNode, JsonValue } from './jsonc.ts';
import { deepEqual, findProp, isPlainObject, JsoncError, parseJsonc, removeEntry, setEntry, toValue } from './jsonc.ts';
import type { Launch } from './launch.ts';
import {
  hasTomlTable,
  readTomlTableValues,
  removeTomlTable,
  setTomlTable,
  TomlError,
  TomlUnsupportedError,
} from './toml.ts';

/** O que o registro precisa do processo: ambiente e sistema (caminhos, `PATH`), o executor e onde avisar. */
export type ClientIo = Pick<CliIo, 'env' | 'platform' | 'exec' | 'stderr'>;

/** O que aconteceu com o registro num arquivo (ou num cliente). */
export type Outcome = 'installed' | 'updated' | 'unchanged' | 'removed' | 'absent';

/** A entrada `cabecao` que foi trocada apontava para outro cérebro. */
export interface ReplacedEntry {
  /** O cérebro da entrada antiga (o valor de `--brain`), ou `null` se ela não tinha um que desse para ler. */
  brain: string | null;
  /** Como a entrada antiga iniciava o servidor: comando e argumentos. */
  command: string;
}

export interface FileReport {
  path: string;
  status: Outcome;
  /** Cópia de segurança criada nesta execução. */
  backup?: string;
  /** Presente quando a entrada trocada apontava para outro cérebro. */
  replaced?: ReplacedEntry;
}

export interface ClientReport {
  client: ClientId;
  label: string;
  status: Outcome | 'failed';
  /** `cli`: pelo comando do próprio cliente (`claude mcp add-json`). `file`: editando o arquivo de configuração. */
  method: 'cli' | 'file';
  files: FileReport[];
  error?: string;
  /** No registro pelo comando do cliente: a entrada trocada apontava para outro cérebro. */
  replaced?: ReplacedEntry;
}

export const CLAUDE_SCOPE = ['--scope', 'user'] as const;

export function tomlEntries(launch: Launch): Record<string, string | readonly string[]> {
  return { command: launch.command, args: launch.args };
}

export function jsonEntry(target: JsonTarget, launch: Launch, existing: unknown): JsonEntry {
  // O que o cabecao define vence; o resto do que o usuário pôs na entrada (env, timeout, tools...) fica.
  return { ...target.defaults, ...(isPlainObject(existing) ? (existing as JsonEntry) : {}), ...target.entry(launch) };
}

const brainOf = (args: readonly string[] | undefined): string | null => {
  const at = args?.indexOf('--brain') ?? -1;
  const value = at === -1 ? undefined : args?.[at + 1];
  return value === undefined || value === '' ? null : value;
};

/**
 * Compara a entrada antiga com a nova: se a antiga apontava para OUTRO cérebro (ou para um que não dá para ler),
 * devolve o que ela tinha, para a saída avisar. Trocar só o caminho do Node ou do cabecao não é avisado.
 */
export function replacedEntry(previous: unknown, launch: Launch): ReplacedEntry | undefined {
  if (!isPlainObject(previous)) return undefined;
  const command = typeof previous.command === 'string' ? previous.command : '';
  const args = Array.isArray(previous.args)
    ? previous.args.filter((arg): arg is string => typeof arg === 'string')
    : [];
  const before = brainOf(args);
  const after = brainOf(launch.args);
  if (before !== null && after !== null && resolve(before) === resolve(after)) return undefined;
  return { brain: before, command: [command, ...args].filter((part) => part !== '').join(' ') };
}

function parseConfig(path: string, text: string): JsonObjectNode {
  let root: ReturnType<typeof parseJsonc>;
  try {
    root = parseJsonc(text);
  } catch (error) {
    if (!(error instanceof JsoncError)) throw error;
    throw new CliError(`${path} não é JSON válido: ${error.message}. Nada foi gravado.`, {
      code: 'ECLIENTCONFIG',
      hint: 'Corrija o arquivo e rode de novo, ou use --print e cole a configuração à mão.',
      cause: error,
    });
  }
  if (root.type !== 'object') {
    throw new CliError(`${path} deveria conter um objeto JSON. Nada foi gravado.`, { code: 'ECLIENTCONFIG' });
  }
  return root;
}

function sectionOf(path: string, root: JsonObjectNode, section: string): Record<string, JsonValue> {
  const prop = findProp(root, section);
  if (prop === undefined) return {};
  if (prop.value.type !== 'object') {
    throw new CliError(`em ${path}, "${section}" deveria ser um objeto. Nada foi gravado.`, { code: 'ECLIENTCONFIG' });
  }
  return toValue(prop.value) as Record<string, JsonValue>;
}

/** O documento sem a nossa entrada: é o que tem de continuar idêntico depois da edição. */
function withoutEntry(document: JsonValue, section: string): JsonValue {
  if (!isPlainObject(document)) return document;
  const servers = isPlainObject(document[section]) ? { ...document[section] } : {};
  delete servers[SERVER_NAME];
  return { ...document, [section]: servers } as JsonValue;
}

/** Última barreira antes de gravar: relê o texto editado e confere que só a nossa entrada mudou. */
function assertOnlyEntryChanged(
  path: string,
  before: JsonValue,
  edited: string,
  section: string,
  expected: unknown,
): void {
  const after = toValue(parseJsonc(edited));
  const entry = isPlainObject(after) && isPlainObject(after[section]) ? after[section][SERVER_NAME] : undefined;
  if (!deepEqual(entry, expected) || !deepEqual(withoutEntry(after, section), withoutEntry(before, section))) {
    throw new Error(`a edição de ${path} alteraria outras partes do arquivo; nada foi gravado`);
  }
}

async function applyJson(target: JsonTarget, launch: Launch | undefined): Promise<FileReport> {
  const state: { outcome: Outcome; replaced?: ReplacedEntry } = { outcome: 'unchanged' };
  const change = await editFile(target.path, (current) => {
    if (current === undefined || current.trim() === '') {
      if (launch === undefined) {
        state.outcome = 'absent';
        return undefined;
      }
      state.outcome = 'installed';
      const document = { [target.section]: { [SERVER_NAME]: jsonEntry(target, launch, undefined) } };
      return `${JSON.stringify(document, null, 2)}\n`;
    }

    const root = parseConfig(target.path, current);
    const existing = sectionOf(target.path, root, target.section)[SERVER_NAME];
    const before = toValue(root);
    if (launch === undefined) {
      if (existing === undefined) {
        state.outcome = 'absent';
        return undefined;
      }
      state.outcome = 'removed';
      const edited = removeEntry(current, root, target.section, SERVER_NAME);
      assertOnlyEntryChanged(target.path, before, edited, target.section, undefined);
      return edited;
    }

    const desired = jsonEntry(target, launch, existing);
    if (deepEqual(existing, desired)) return undefined;
    state.outcome = existing === undefined ? 'installed' : 'updated';
    const replaced = existing === undefined ? undefined : replacedEntry(existing, launch);
    if (replaced !== undefined) state.replaced = replaced;
    const edited = setEntry(current, root, target.section, SERVER_NAME, desired);
    assertOnlyEntryChanged(target.path, before, edited, target.section, desired);
    return edited;
  });
  return {
    path: target.path,
    status: state.outcome,
    ...(change.backup === undefined ? {} : { backup: change.backup }),
    ...(state.replaced === undefined ? {} : { replaced: state.replaced }),
  };
}

async function applyToml(target: TomlTarget, launch: Launch | undefined): Promise<FileReport> {
  const state: { outcome: Outcome; replaced?: ReplacedEntry } = { outcome: 'unchanged' };
  const change = await editFile(target.path, (current) => {
    const text = current ?? '';
    try {
      const existed = hasTomlTable(text, target.table);
      if (launch === undefined) {
        if (!existed) {
          state.outcome = 'absent';
          return undefined;
        }
        state.outcome = 'removed';
        const edited = removeTomlTable(text, target.table);
        if (hasTomlTable(edited, target.table)) throw new Error(`não consegui tirar o registro de ${target.path}`);
        return edited;
      }
      const edited = setTomlTable(text, target.table, tomlEntries(launch));
      if (edited === text) return undefined;
      state.outcome = existed ? 'updated' : 'installed';
      const replaced = existed ? replacedEntry(readTomlTableValues(text, target.table), launch) : undefined;
      if (replaced !== undefined) state.replaced = replaced;
      // Relê o resultado: se a edição tivesse quebrado o arquivo, o erro aparece aqui, antes de gravar.
      if (!hasTomlTable(edited, target.table)) throw new Error(`a edição de ${target.path} não ficou como esperado`);
      return edited;
    } catch (error) {
      if (error instanceof TomlError) {
        throw new CliError(`${target.path} não é TOML válido: ${error.message}. Nada foi gravado.`, {
          code: 'ECLIENTCONFIG',
          hint: 'Corrija o arquivo e rode de novo, ou use --print e cole a configuração à mão.',
          cause: error,
        });
      }
      if (error instanceof TomlUnsupportedError) {
        throw new CliError(`em ${target.path}, ${error.message}. Nada foi gravado.`, {
          code: 'ECLIENTCONFIG',
          hint: 'Use --print e ajuste o arquivo à mão.',
          cause: error,
        });
      }
      throw error;
    }
  });
  return {
    path: target.path,
    status: state.outcome,
    ...(change.backup === undefined ? {} : { backup: change.backup }),
    ...(state.replaced === undefined ? {} : { replaced: state.replaced }),
  };
}

function applyTarget(target: Target, launch: Launch | undefined): Promise<FileReport> {
  return target.format === 'json' ? applyJson(target, launch) : applyToml(target, launch);
}

/** Resume o estado de vários arquivos num só: qualquer mudança vence "já estava". */
function overall(statuses: readonly Outcome[], removing: boolean): Outcome {
  if (removing) return statuses.includes('removed') ? 'removed' : 'absent';
  if (statuses.includes('installed')) return 'installed';
  return statuses.includes('updated') ? 'updated' : 'unchanged';
}

async function applyFiles(def: ClientDef, location: Location, launch: Launch | undefined): Promise<ClientReport> {
  const files: FileReport[] = [];
  for (const target of def.targets(location)) {
    if (target.when === 'if-dir-exists' && !(await isDirectory(dirname(target.path)))) continue;
    files.push(await applyTarget(target, launch));
  }
  const status = overall(
    files.map((file) => file.status),
    launch === undefined,
  );
  return { client: def.id, label: def.label, status, method: 'file', files };
}

type KnownEntry = { known: true; entry: JsonValue | undefined } | { known: false };

/** O registro atual no arquivo do Claude Code, só para leitura. `known: false` se o arquivo não pôde ser lido. */
async function readClaudeEntry(target: JsonTarget): Promise<KnownEntry> {
  let text: string;
  try {
    text = await readFile(target.path, 'utf8');
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { known: true, entry: undefined };
    }
    return { known: false };
  }
  try {
    const document = toValue(parseJsonc(text));
    const servers = isPlainObject(document) ? document[target.section] : undefined;
    return { known: true, entry: isPlainObject(servers) ? (servers[SERVER_NAME] as JsonValue | undefined) : undefined };
  } catch {
    return { known: false };
  }
}

function failure(result: { stdout: string; stderr: string }): string {
  return (result.stderr.trim() || result.stdout.trim() || 'sem mensagem').split('\n').slice(-3).join(' ');
}

/**
 * Claude Code: quando o comando `claude` existe, o registro é feito por ele (`claude mcp add-json`, escopo `user`),
 * que é quem conhece o formato do `~/.claude.json`. Sem o comando, ou quando no Windows ele é um `.cmd` (que não
 * pode ser iniciado sem shell com um JSON nos argumentos), o cabecao edita `mcpServers` no arquivo.
 *
 * `add-json` falha se o nome já existe e `remove` falha se não existe (spike 15): por isso lemos o arquivo antes,
 * para não mexer quando já está certo e para só remover o que de fato existe.
 */
async function applyClaudeCode(
  ctx: ClientIo,
  def: ClientDef,
  location: Location,
  launch: Launch | undefined,
): Promise<ClientReport> {
  const [target] = def.targets(location);
  if (target === undefined || target.format !== 'json') throw new Error('definição do Claude Code sem arquivo JSON');
  const claude = await findExecutable('claude', ctx);
  if (claude === undefined || (ctx.platform === 'win32' && /\.(?:cmd|bat)$/i.test(claude))) {
    return applyFiles(def, location, launch);
  }

  const report = (status: Outcome): ClientReport => ({
    client: def.id,
    label: def.label,
    status,
    method: 'cli',
    files: [],
  });
  const current = await readClaudeEntry(target);
  const removeArgs = ['mcp', 'remove', SERVER_NAME, ...CLAUDE_SCOPE];

  if (launch === undefined) {
    if (current.known && current.entry === undefined) return report('absent');
    const removed = await ctx.exec(claude, removeArgs, { env: ctx.env });
    if (removed.code === 0) return report('removed');
    if (removed.code === null) return applyFiles(def, location, launch);
    if (!current.known) return report('absent');
    throw new CliError(`"claude mcp remove" falhou: ${failure(removed)}`);
  }

  const desired = jsonEntry(target, launch, current.known ? current.entry : undefined);
  if (current.known && deepEqual(current.entry, desired)) return report('unchanged');
  const exists = !current.known || current.entry !== undefined;
  // O resultado do `remove` é ignorado de propósito: "não existe" também sai com código 1.
  if (exists) await ctx.exec(claude, removeArgs, { env: ctx.env });
  const added = await ctx.exec(claude, ['mcp', 'add-json', SERVER_NAME, ...CLAUDE_SCOPE, JSON.stringify(desired)], {
    env: ctx.env,
  });
  // `code: null`: o programa nem chegou a rodar (sem permissão, formato que o sistema não executa). Recua para
  // a edição do arquivo, que é o mesmo destino.
  if (added.code === null) return applyFiles(def, location, launch);
  if (added.code !== 0) {
    // O registro antigo já saiu: tenta devolvê-lo, para a falha não deixar o cliente sem o servidor.
    if (current.known && current.entry !== undefined) {
      await ctx.exec(claude, ['mcp', 'add-json', SERVER_NAME, ...CLAUDE_SCOPE, JSON.stringify(current.entry)], {
        env: ctx.env,
      });
    }
    throw new CliError(`"claude mcp add-json" falhou: ${failure(added)}`);
  }
  const replaced = current.known && current.entry !== undefined ? replacedEntry(current.entry, launch) : undefined;
  return {
    ...report(current.known && current.entry !== undefined ? 'updated' : 'installed'),
    ...(replaced === undefined ? {} : { replaced }),
  };
}

async function isDetected(ctx: ClientIo, def: ClientDef, location: Location): Promise<boolean> {
  for (const dir of def.detectDirs(location)) {
    if (await isDirectory(dir)) return true;
  }
  for (const file of def.detectFiles?.(location) ?? []) {
    if (await isFile(file)) return true;
  }
  return def.binary !== undefined && (await findExecutable(def.binary, ctx)) !== undefined;
}

export const OUTCOME_TEXT: Readonly<Record<Outcome, string>> = {
  installed: 'registrado',
  updated: 'registro atualizado',
  unchanged: 'já estava registrado',
  removed: 'registro removido',
  absent: 'não estava registrado',
};

/** Aviso de que a entrada trocada apontava para outro cérebro, com o que ela tinha. */
export function replacedText(replaced: ReplacedEntry): string {
  const brain =
    replaced.brain === null ? 'um cérebro que não deu para identificar' : `outro cérebro (${replaced.brain})`;
  return `ATENÇÃO: a entrada "${SERVER_NAME}" que havia apontava para ${brain} e foi trocada. Antes: ${replaced.command || '(sem comando)'}`;
}

export function reportText(reports: readonly ClientReport[]): string {
  const lines: string[] = [];
  for (const report of reports) {
    if (report.status === 'failed') continue;
    const where = report.method === 'cli' ? ' pelo comando "claude mcp" (escopo user)' : '';
    lines.push(`${report.label}: ${OUTCOME_TEXT[report.status]}${where}`);
    const notice = CLIENTS[report.client].notice;
    if (notice !== undefined && report.status !== 'removed' && report.status !== 'absent')
      lines.push(`  aviso: ${notice}`);
    if (report.replaced !== undefined) lines.push(`  ${replacedText(report.replaced)}`);
    for (const file of report.files) {
      const backup = file.backup === undefined ? '' : ` (original guardado em ${file.backup})`;
      lines.push(`  ${file.path}: ${OUTCOME_TEXT[file.status]}${backup}`);
      if (file.replaced !== undefined) lines.push(`    ${replacedText(file.replaced)}`);
    }
  }
  const changed = reports.some((report) => ['installed', 'updated', 'removed'].includes(report.status));
  if (changed) lines.push('Reinicie o cliente para ele enxergar a mudança.');
  return lines.join('\n');
}

/** Clientes instalados nesta máquina (pasta de configuração existente ou executável no `PATH`), na ordem fixa. */
export async function detectClients(io: ClientIo, location: Location): Promise<ClientId[]> {
  const ids: ClientId[] = [];
  for (const id of CLIENT_IDS) {
    if (await isDetected(io, CLIENTS[id], location)) ids.push(id);
  }
  return ids;
}

/**
 * Registra (`launch`) ou tira o registro (`undefined`) do servidor em cada cliente. Um cliente com problema não
 * impede os outros: o erro vai para stderr e o relatório dele sai como `failed`.
 */
export async function registerClients(
  io: ClientIo,
  ids: readonly ClientId[],
  location: Location,
  launch: Launch | undefined,
): Promise<ClientReport[]> {
  const reports: ClientReport[] = [];
  for (const id of ids) {
    const def = CLIENTS[id];
    try {
      reports.push(
        id === 'claude-code'
          ? await applyClaudeCode(io, def, location, launch)
          : await applyFiles(def, location, launch),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      io.stderr.write(`cabecao: ${def.label}: ${message}\n`);
      if (error instanceof CliError && error.hint !== undefined) io.stderr.write(`${error.hint}\n`);
      if (io.env.CABECAO_DEBUG === '1' && error instanceof Error && error.stack !== undefined) {
        io.stderr.write(`${error.stack}\n`);
      }
      reports.push({ client: id, label: def.label, status: 'failed', method: 'file', files: [], error: message });
    }
  }
  return reports;
}

/** Situação do registro num arquivo do cliente. */
export type RegistrationState =
  /** O arquivo tem exatamente o que `install-client` gravaria agora (para um dos jeitos de iniciar). */
  | 'current'
  /** Há uma entrada `cabecao`, mas diferente: outro cérebro, outro caminho do Node ou do cabecao. */
  | 'different'
  /** O arquivo não existe ou não tem a entrada. */
  | 'missing'
  /** O arquivo existe, mas não deu para ler (JSON ou TOML quebrado). */
  | 'unreadable';

export interface FileRegistration {
  path: string;
  state: RegistrationState;
  /** Em JSON, a entrada encontrada (para mostrar o que difere). */
  entry?: JsonValue;
  /**
   * Caminhos absolutos da entrada que não existem mais: o Node (removido com nvm, fnm ou Volta, por exemplo) ou o
   * arquivo do cabecao. Com eles, o cliente nem consegue iniciar o servidor.
   */
  gone?: string[];
}

/** Os caminhos absolutos de uma entrada (`command` e o arquivo `.mjs`/`.js` em `args`) que não existem. */
export function goneLaunchPaths(entry: unknown): string[] {
  if (!isPlainObject(entry)) return [];
  const candidates: string[] = [];
  if (typeof entry.command === 'string') candidates.push(entry.command);
  if (Array.isArray(entry.args)) {
    const script = entry.args.find((arg): arg is string => typeof arg === 'string' && /\.[cm]?js$/.test(arg));
    if (script !== undefined) candidates.push(script);
  }
  return candidates.filter((path) => (isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)) && !existsSync(path));
}

export interface ClientRegistration {
  client: ClientId;
  label: string;
  files: FileRegistration[];
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

function jsonRegistration(target: JsonTarget, text: string, launches: readonly Launch[]): FileRegistration {
  let document: JsonValue;
  try {
    document = toValue(parseJsonc(text));
  } catch {
    return { path: target.path, state: 'unreadable' };
  }
  const servers = isPlainObject(document) ? document[target.section] : undefined;
  const entry = isPlainObject(servers) ? (servers[SERVER_NAME] as JsonValue | undefined) : undefined;
  if (entry === undefined) return { path: target.path, state: 'missing' };
  const current = launches.some((launch) => deepEqual(entry, jsonEntry(target, launch, entry)));
  const gone = current ? [] : goneLaunchPaths(entry);
  return { path: target.path, state: current ? 'current' : 'different', entry, ...(gone.length > 0 ? { gone } : {}) };
}

function tomlRegistration(target: TomlTarget, text: string, launches: readonly Launch[]): FileRegistration {
  try {
    if (!hasTomlTable(text, target.table)) return { path: target.path, state: 'missing' };
    const current = launches.some((launch) => setTomlTable(text, target.table, tomlEntries(launch)) === text);
    const gone = current ? [] : goneLaunchPaths(readTomlTableValues(text, target.table));
    return { path: target.path, state: current ? 'current' : 'different', ...(gone.length > 0 ? { gone } : {}) };
  } catch {
    return { path: target.path, state: 'unreadable' };
  }
}

/**
 * Lê, sem alterar nada e sem executar nenhum programa, como cada cliente está registrado. `launches` são os jeitos
 * aceitos de iniciar o servidor (o caminho direto e o `npx`, para este cérebro). Arquivos opcionais (`if-dir-exists`)
 * cuja pasta não existe ficam de fora.
 */
export async function readRegistrations(
  ids: readonly ClientId[],
  location: Location,
  launches: readonly Launch[],
): Promise<ClientRegistration[]> {
  const result: ClientRegistration[] = [];
  for (const id of ids) {
    const def = CLIENTS[id];
    const files: FileRegistration[] = [];
    for (const target of def.targets(location)) {
      if (target.when === 'if-dir-exists' && !(await isDirectory(dirname(target.path)))) continue;
      const text = await readText(target.path);
      if (text === undefined || text.trim() === '') files.push({ path: target.path, state: 'missing' });
      else
        files.push(
          target.format === 'json'
            ? jsonRegistration(target, text, launches)
            : tomlRegistration(target, text, launches),
        );
    }
    result.push({ client: id, label: def.label, files });
  }
  return result;
}
