import { resolve } from 'node:path';
import type { ParseArgsOptionsConfig } from 'node:util';
import { parseArgs } from 'node:util';
import { COMMANDS } from './commands.ts';
import { CliError, UsageError } from './errors.ts';
import type { CliIo, CommandContext, CommandSpec, OptionSpec, OptionValue } from './types.ts';
import { CLI_NAME, HOMEPAGE, VERSION } from './version.ts';

// Este módulo roda em todo início, inclusive em `--version`. Não importe aqui nada do núcleo nem de um comando:
// o código pesado só entra pelo `load()` do registro.

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

/** Variável de ambiente alternativa a `--brain`. */
export const BRAIN_ENV = 'CABECAO_BRAIN';
/** Com `CABECAO_DEBUG=1`, os erros saem com o stack. */
export const DEBUG_ENV = 'CABECAO_DEBUG';

export const GLOBAL_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  brain: { type: 'string', valueName: 'pasta', description: `Pasta do cérebro (ou a variável ${BRAIN_ENV})` },
  json: { type: 'boolean', description: 'Saída estruturada em JSON, para scripts e hooks' },
  help: { type: 'boolean', short: 'h', description: 'Mostra a ajuda' },
  version: { type: 'boolean', short: 'v', description: 'Mostra a versão' },
};

type Values = Record<string, OptionValue>;

function parseConfig(options: Readonly<Record<string, OptionSpec>>): ParseArgsOptionsConfig {
  const config: ParseArgsOptionsConfig = {};
  for (const [name, spec] of Object.entries(options)) {
    config[name] = {
      type: spec.type,
      ...(spec.short === undefined ? {} : { short: spec.short }),
      ...(spec.multiple === undefined ? {} : { multiple: spec.multiple }),
    };
  }
  return config;
}

/** Traduz o erro do `parseArgs` (em inglês) para uma mensagem de uso em português. */
function translateParseError(error: unknown): UsageError {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  const option = /'(-{1,2}[^\s'=<]+)/.exec(message)?.[1];
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && option !== undefined) {
    return new UsageError(`opção desconhecida: ${option}`);
  }
  if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' && option !== undefined) {
    if (message.includes('missing')) return new UsageError(`a opção ${option} precisa de um valor`);
    if (message.includes('does not take')) return new UsageError(`a opção ${option} não recebe valor`);
    if (message.includes('ambiguous')) {
      return new UsageError(
        `a opção ${option} precisa de um valor (para um valor que começa com "-", use ${option}=<valor>)`,
      );
    }
  }
  return new UsageError(`argumentos inválidos: ${message}`);
}

function parseStrict(
  args: readonly string[],
  options: Readonly<Record<string, OptionSpec>>,
): { values: Values; positionals: string[] } {
  try {
    const parsed = parseArgs({ args: [...args], options: parseConfig(options), strict: true, allowPositionals: true });
    return { values: parsed.values as Values, positionals: parsed.positionals };
  } catch (error) {
    throw translateParseError(error);
  }
}

/**
 * Acha o nome do comando: o primeiro argumento posicional. As opções globais podem vir antes dele
 * (`cabecao --json status`); as do comando vêm depois.
 */
function locateCommand(argv: readonly string[]): { name: string; index: number } | undefined {
  const { tokens } = parseArgs({
    args: [...argv],
    options: parseConfig(GLOBAL_OPTIONS),
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  const first = tokens.find((token) => token.kind === 'positional');
  return first?.kind === 'positional' ? { name: first.value, index: first.index } : undefined;
}

function optionLabel(name: string, spec: OptionSpec): string {
  const long = spec.type === 'string' ? `--${name} <${spec.valueName ?? 'valor'}>` : `--${name}`;
  return spec.short === undefined ? `    ${long}` : `-${spec.short}, ${long}`;
}

function table(rows: ReadonlyArray<readonly [string, string]>): string {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`).join('\n');
}

function optionsTable(options: Readonly<Record<string, OptionSpec>>): string {
  return table(Object.entries(options).map(([name, spec]) => [optionLabel(name, spec), spec.description] as const));
}

export function generalHelp(commands: readonly CommandSpec[]): string {
  const lines = [
    `${CLI_NAME} ${VERSION}`,
    'Segundo cérebro pessoal em Markdown e git, para você e seus agentes de IA.',
    '',
    'Uso:',
    `  ${CLI_NAME} <comando> [opções]`,
    `  ${CLI_NAME} <comando> --help`,
    '',
    'Comandos:',
    table(commands.map((command) => [command.name, command.summary] as const)),
    '',
    'Opções globais:',
    optionsTable(GLOBAL_OPTIONS),
    '',
    'Para começar:',
    `  ${CLI_NAME} init <url-do-repositório>   numa máquina nova (ou sem URL, para um cérebro só local)`,
    `  ${CLI_NAME} doctor                       se algo parecer errado`,
    '',
    `O cérebro usado é o de --brain, senão o de ${BRAIN_ENV}, senão o padrão desta máquina (gravado pelo init),`,
    'senão a pasta atual, se ela for um cérebro.',
    '',
    HOMEPAGE,
  ];
  return `${lines.join('\n')}\n`;
}

export function commandHelp(command: CommandSpec): string {
  const lines = [
    `${CLI_NAME} ${command.name}: ${command.summary}`,
    '',
    'Uso:',
    ...command.usage.map((line) => `  ${CLI_NAME} ${line}`),
  ];
  if (command.options !== undefined && Object.keys(command.options).length > 0) {
    lines.push('', 'Opções:', optionsTable(command.options));
  }
  lines.push('', 'Opções globais:', optionsTable(GLOBAL_OPTIONS));
  if (command.details !== undefined) lines.push('', command.details);
  return `${lines.join('\n')}\n`;
}

function writeJson(io: CliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value)}\n`);
}

function printVersion(io: CliIo, json: boolean): number {
  if (json) writeJson(io, { ok: true, command: null, data: { version: VERSION } });
  else io.stdout.write(`${VERSION}\n`);
  return EXIT_OK;
}

function printGeneralHelp(io: CliIo, json: boolean, commands: readonly CommandSpec[]): number {
  if (json) {
    const list = commands.map(({ name, summary, usage }) => ({ name, summary, usage }));
    writeJson(io, { ok: true, command: null, data: { version: VERSION, commands: list } });
  } else {
    io.stdout.write(generalHelp(commands));
  }
  return EXIT_OK;
}

function printCommandHelp(io: CliIo, json: boolean, command: CommandSpec): number {
  if (json) {
    const { name, summary, usage, options = {} } = command;
    writeJson(io, { ok: true, command: name, data: { name, summary, usage, options } });
  } else {
    io.stdout.write(commandHelp(command));
  }
  return EXIT_OK;
}

function findCommand(commands: readonly CommandSpec[], name: string): CommandSpec {
  const command = commands.find((candidate) => candidate.name === name);
  if (command === undefined) throw new UsageError(`comando desconhecido: ${name}`);
  return command;
}

function explicitBrain(io: CliIo, values: Values): string | undefined {
  const flag = values.brain;
  if (flag === '') throw new UsageError('a opção --brain precisa de uma pasta');
  const chosen = typeof flag === 'string' ? flag : io.env[BRAIN_ENV];
  return chosen === undefined || chosen === '' ? undefined : resolve(io.cwd, chosen);
}

function reportError(
  io: CliIo,
  error: unknown,
  command: string | undefined,
  json: boolean,
  ownsStdout = false,
): number {
  const usage = error instanceof UsageError;
  const expected = usage || error instanceof CliError;
  const debug = io.env[DEBUG_ENV] === '1';
  const message = error instanceof Error ? error.message : String(error);

  io.stderr.write(`${CLI_NAME}: ${message}\n`);
  if (usage) {
    const help = command === undefined ? `${CLI_NAME} --help` : `${CLI_NAME} ${command} --help`;
    io.stderr.write(`Rode ${help} para ver ${command === undefined ? 'o que existe' : 'o uso'}.\n`);
  }
  if (error instanceof CliError && error.hint !== undefined) io.stderr.write(`${error.hint}\n`);
  if (debug) {
    if (error instanceof Error && error.stack !== undefined) io.stderr.write(`${error.stack}\n`);
  } else if (!expected) {
    io.stderr.write(`Rode de novo com ${DEBUG_ENV}=1 para ver os detalhes.\n`);
  }

  if (json && !ownsStdout) {
    const code = error instanceof CliError ? error.code : undefined;
    const hint = error instanceof CliError ? error.hint : undefined;
    writeJson(io, {
      ok: false,
      command: command ?? null,
      error: {
        kind: usage ? 'usage' : 'runtime',
        message,
        ...(code === undefined ? {} : { code }),
        ...(hint === undefined ? {} : { hint }),
      },
    });
  }
  return usage ? EXIT_USAGE : EXIT_ERROR;
}

/**
 * Interpreta os argumentos, mostra ajuda ou versão, ou carrega e roda o comando. Devolve o código de saída:
 * 0 quando deu certo, 2 em erro de uso, 1 em erro de execução. Nunca lança.
 */
export async function execute(io: CliIo, commands: readonly CommandSpec[] = COMMANDS): Promise<number> {
  // Vale até os argumentos serem validados: um erro de uso ainda precisa saber se sai em JSON.
  let json = io.argv.includes('--json');
  let known: string | undefined;
  let ownsStdout = false;
  try {
    const located = locateCommand(io.argv);
    if (located === undefined) {
      const { values } = parseStrict(io.argv, GLOBAL_OPTIONS);
      json = values.json === true;
      return values.version === true ? printVersion(io, json) : printGeneralHelp(io, json, commands);
    }

    const rest = io.argv.filter((_, index) => index !== located.index);
    if (located.name === 'help') {
      // `cabecao help [comando]` é o mesmo que `--help`.
      const { values, positionals } = parseStrict(rest, GLOBAL_OPTIONS);
      json = values.json === true;
      const [topic] = positionals;
      if (topic === undefined) return printGeneralHelp(io, json, commands);
      return printCommandHelp(io, json, findCommand(commands, topic));
    }

    const command = findCommand(commands, located.name);
    known = command.name;
    const { values, positionals } = parseStrict(rest, { ...command.options, ...GLOBAL_OPTIONS });
    // Só depois de os argumentos serem aceitos: `mcp --help` e erros de uso continuam saindo normalmente.
    ownsStdout = command.ownsStdout === true && values.help !== true && values.version !== true;
    json = values.json === true;
    if (values.version === true) return printVersion(io, json);
    if (values.help === true) return printCommandHelp(io, json, command);

    const ctx: CommandContext = {
      ...io,
      command: command.name,
      values,
      positionals,
      json,
      brain: explicitBrain(io, values),
      version: VERSION,
    };
    const { run } = await command.load();
    const result = await run(ctx);
    const code = result.code ?? EXIT_OK;
    if (ownsStdout) return code;
    if (json) writeJson(io, { ok: code === EXIT_OK, command: command.name, data: result.data ?? null });
    else if (result.text !== undefined && result.text !== '') {
      io.stdout.write(result.text.endsWith('\n') ? result.text : `${result.text}\n`);
    }
    return code;
  } catch (error) {
    return reportError(io, error, known, json, ownsStdout);
  }
}
