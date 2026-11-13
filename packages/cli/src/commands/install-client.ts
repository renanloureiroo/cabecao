import { homeDir, resolveBrain } from '../brain.ts';
import { UsageError } from '../errors.ts';
import type { ClientDef, ClientId, Location } from '../install-client/clients.ts';
import { CLIENT_IDS, CLIENTS, isClientId, SERVER_NAME } from '../install-client/clients.ts';
import { isDirectory } from '../install-client/files.ts';
import type { Launch } from '../install-client/launch.ts';
import { resolveLaunch } from '../install-client/launch.ts';
import {
  CLAUDE_SCOPE,
  detectClients,
  jsonEntry,
  registerClients,
  reportText,
  tomlEntries,
} from '../install-client/register.ts';
import { tomlTable } from '../install-client/toml.ts';
import { didYouMean } from '../suggest.ts';
import type { CommandContext, CommandResult } from '../types.ts';

export type { ClientReport, FileReport, Outcome } from '../install-client/register.ts';

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
    const notice = CLIENTS[client.client].notice;
    if (notice !== undefined) lines.push(`# aviso: ${notice}`);
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

function selectedIds(ctx: CommandContext): ClientId[] {
  const unknown = ctx.positionals.filter((name) => !isClientId(name));
  if (unknown.length > 0) {
    const [first = ''] = unknown;
    throw new UsageError(
      `cliente desconhecido: ${unknown.join(', ')}.${didYouMean(first, CLIENT_IDS)} Os clientes são: ${CLIENT_IDS.join(', ')}`,
    );
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
    ids = await detectClients(ctx, location);
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
    return {
      data: { action, brain, launch, clients: [] },
      text: remove
        ? 'Nenhum cliente de IA foi detectado nesta máquina.'
        : 'Nenhum cliente de IA foi detectado nesta máquina. Depois de instalar um (Claude Code, Codex, Cursor, VS Code, Antigravity), rode "cabecao install-client --all" de novo, ou "cabecao install-client --print" para configurar à mão.',
    };
  }
  if (brain !== undefined && !(await isDirectory(brain))) {
    ctx.stderr.write(`cabecao: aviso: a pasta do cérebro ainda não existe: ${brain}\n`);
  }

  const reports = await registerClients(ctx, ids, location, launch);

  const failed = reports.some((report) => report.status === 'failed');
  return { code: failed ? 1 : 0, data: { action, brain, launch, clients: reports }, text: reportText(reports) };
}
