import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { homeDir, resolveBrain } from '../brain.ts';
import { CliError, UsageError } from '../errors.ts';
import type {
  ClientDef,
  ClientId,
  JsonEntry,
  JsonTarget,
  Location,
  Target,
  TomlTarget,
} from '../install-client/clients.ts';
import { CLIENT_IDS, CLIENTS, isClientId, SERVER_NAME } from '../install-client/clients.ts';
import { editFile, findExecutable, isDirectory } from '../install-client/files.ts';
import type { JsonObjectNode, JsonValue } from '../install-client/jsonc.ts';
import {
  deepEqual,
  findProp,
  isPlainObject,
  JsoncError,
  parseJsonc,
  removeEntry,
  setEntry,
  toValue,
} from '../install-client/jsonc.ts';
import type { Launch } from '../install-client/launch.ts';
import { resolveLaunch } from '../install-client/launch.ts';
import {
  hasTomlTable,
  removeTomlTable,
  setTomlTable,
  TomlError,
  TomlUnsupportedError,
  tomlTable,
} from '../install-client/toml.ts';
import type { CommandContext, CommandResult } from '../types.ts';

/** O que aconteceu com o registro num arquivo (ou num cliente). */
export type Outcome = 'installed' | 'updated' | 'unchanged' | 'removed' | 'absent';

export interface FileReport {
  path: string;
  status: Outcome;
  /** Cópia de segurança criada nesta execução. */
  backup?: string;
}

export interface ClientReport {
  client: ClientId;
  label: string;
  status: Outcome | 'failed';
  /** `cli`: pelo comando do próprio cliente (`claude mcp add-json`). `file`: editando o arquivo de configuração. */
  method: 'cli' | 'file';
  files: FileReport[];
  error?: string;
}

export interface PrintedFile {
  path: string;
  format: 'json' | 'toml';
  content: string;
  note?: string;
}

export interface PrintedClient {
  client: ClientId;
  label: string;
  /** Comando equivalente, quando o cliente tem um. */
  command?: string[];
  files: PrintedFile[];
}

const CLAUDE_SCOPE = ['--scope', 'user'] as const;

function tomlEntries(launch: Launch): Record<string, string | readonly string[]> {
  return { command: launch.command, args: launch.args };
}

function jsonEntry(target: JsonTarget, launch: Launch, existing: unknown): JsonEntry {
  // O que o cabecao define vence; o resto do que o usuário pôs na entrada (env, timeout, tools...) fica.
  return { ...target.defaults, ...(isPlainObject(existing) ? (existing as JsonEntry) : {}), ...target.entry(launch) };
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
  const state: { outcome: Outcome } = { outcome: 'unchanged' };
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
    const edited = setEntry(current, root, target.section, SERVER_NAME, desired);
    assertOnlyEntryChanged(target.path, before, edited, target.section, desired);
    return edited;
  });
  return {
    path: target.path,
    status: state.outcome,
    ...(change.backup === undefined ? {} : { backup: change.backup }),
  };
}

async function applyToml(target: TomlTarget, launch: Launch | undefined): Promise<FileReport> {
  const state: { outcome: Outcome } = { outcome: 'unchanged' };
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
  ctx: CommandContext,
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
  return report(current.known && current.entry !== undefined ? 'updated' : 'installed');
}

async function isDetected(ctx: CommandContext, def: ClientDef, location: Location): Promise<boolean> {
  for (const dir of def.detectDirs(location)) {
    if (await isDirectory(dir)) return true;
  }
  return def.binary !== undefined && (await findExecutable(def.binary, ctx)) !== undefined;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_\-./:=@]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function printed(def: ClientDef, location: Location, launch: Launch): PrintedClient {
  const files = def.targets(location).map((target): PrintedFile => {
    const content =
      target.format === 'json'
        ? `${JSON.stringify({ [target.section]: { [SERVER_NAME]: jsonEntry(target, launch, undefined) } }, null, 2)}\n`
        : tomlTable(target.table, tomlEntries(launch));
    return {
      path: target.path,
      format: target.format,
      content,
      ...(target.note === undefined ? {} : { note: target.note }),
    };
  });
  const [first] = def.targets(location);
  if (def.id !== 'claude-code' || first?.format !== 'json') return { client: def.id, label: def.label, files };
  const json = JSON.stringify(jsonEntry(first, launch, undefined));
  const command = ['claude', 'mcp', 'add-json', SERVER_NAME, ...CLAUDE_SCOPE, json];
  return { client: def.id, label: def.label, command, files };
}

function printedText(clients: readonly PrintedClient[]): string {
  const blocks = clients.map((client) => {
    const lines = [`# ${client.label}`];
    if (client.command !== undefined) {
      lines.push(client.command.map(shellQuote).join(' '), '', '# ou, sem o comando do cliente, direto no arquivo:');
    }
    for (const file of client.files) {
      lines.push(`# ${file.path}${file.note === undefined ? '' : ` (${file.note})`}`, file.content);
    }
    return lines.join('\n');
  });
  return blocks.join('\n');
}

const OUTCOME_TEXT: Readonly<Record<Outcome, string>> = {
  installed: 'registrado',
  updated: 'registro atualizado',
  unchanged: 'já estava registrado',
  removed: 'registro removido',
  absent: 'não estava registrado',
};

function reportText(reports: readonly ClientReport[]): string {
  const lines: string[] = [];
  for (const report of reports) {
    if (report.status === 'failed') continue;
    const where = report.method === 'cli' ? ' pelo comando "claude mcp" (escopo user)' : '';
    lines.push(`${report.label}: ${OUTCOME_TEXT[report.status]}${where}`);
    for (const file of report.files) {
      const backup = file.backup === undefined ? '' : ` (original guardado em ${file.backup})`;
      lines.push(`  ${file.path}: ${OUTCOME_TEXT[file.status]}${backup}`);
    }
  }
  const changed = reports.some((report) => ['installed', 'updated', 'removed'].includes(report.status));
  if (changed) lines.push('Reinicie o cliente para ele enxergar a mudança.');
  return lines.join('\n');
}

function selectedIds(ctx: CommandContext): ClientId[] {
  const unknown = ctx.positionals.filter((name) => !isClientId(name));
  if (unknown.length > 0) {
    throw new UsageError(`cliente desconhecido: ${unknown.join(', ')}. Os clientes são: ${CLIENT_IDS.join(', ')}`);
  }
  return [...new Set(ctx.positionals.filter(isClientId))];
}

export async function run(ctx: CommandContext): Promise<CommandResult> {
  const all = ctx.values.all === true;
  const print = ctx.values.print === true;
  const remove = ctx.values.remove === true;
  const named = selectedIds(ctx);

  if (print && remove) throw new UsageError('--print e --remove não combinam');
  if (all && named.length > 0) throw new UsageError('use --all ou o nome dos clientes, não os dois');
  if (!all && !print && named.length === 0) {
    throw new UsageError(`diga o cliente (${CLIENT_IDS.join(', ')}) ou use --all`);
  }

  const location: Location = { platform: ctx.platform, env: ctx.env, home: homeDir(ctx) };
  let ids = named;
  if (all) {
    ids = [];
    for (const id of CLIENT_IDS) {
      if (await isDetected(ctx, CLIENTS[id], location)) ids.push(id);
    }
  } else if (named.length === 0) {
    // `--print` sem nome mostra a configuração de todos.
    ids = [...CLIENT_IDS];
  }

  let launch: Launch | undefined;
  let brain: string | undefined;
  if (!remove) {
    brain = await resolveBrain(ctx);
    launch = await resolveLaunch(ctx, brain, ctx.values.npx === true);
  }

  if (print && launch !== undefined) {
    const clients = ids.map((id) => printed(CLIENTS[id], location, launch));
    return { data: { action: 'print', brain, launch, clients }, text: printedText(clients) };
  }

  const action = remove ? 'remove' : 'install';
  if (ids.length === 0) {
    return { data: { action, brain, launch, clients: [] }, text: 'Nenhum cliente de IA foi detectado nesta máquina.' };
  }
  if (brain !== undefined && !(await isDirectory(brain))) {
    ctx.stderr.write(`cabecao: aviso: a pasta do cérebro ainda não existe: ${brain}\n`);
  }

  const reports: ClientReport[] = [];
  for (const id of ids) {
    const def = CLIENTS[id];
    try {
      reports.push(
        id === 'claude-code'
          ? await applyClaudeCode(ctx, def, location, launch)
          : await applyFiles(def, location, launch),
      );
    } catch (error) {
      // Um cliente com problema não impede os outros; o código de saída acusa a falha.
      const message = error instanceof Error ? error.message : String(error);
      ctx.stderr.write(`cabecao: ${def.label}: ${message}\n`);
      if (error instanceof CliError && error.hint !== undefined) ctx.stderr.write(`${error.hint}\n`);
      if (ctx.env.CABECAO_DEBUG === '1' && error instanceof Error && error.stack !== undefined) {
        ctx.stderr.write(`${error.stack}\n`);
      }
      reports.push({ client: id, label: def.label, status: 'failed', method: 'file', files: [], error: message });
    }
  }

  const failed = reports.some((report) => report.status === 'failed');
  return { code: failed ? 1 : 0, data: { action, brain, launch, clients: reports }, text: reportText(reports) };
}
