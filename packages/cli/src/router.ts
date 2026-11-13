import { resolve } from 'node:path';
import type { ParseArgsOptionsConfig } from 'node:util';
import { parseArgs } from 'node:util';
import { accessOf } from './access.ts';
import { resolveActor } from './actor.ts';
import { COMMANDS } from './commands.ts';
import { CliError, UsageError } from './errors.ts';
import { EXAMPLES, GROUPS } from './help.ts';
import { upgradeHint } from './install-method.ts';
import { didYouMean } from './suggest.ts';
import { systemError } from './syserr.ts';
import { fill, reflow, words, wrapLine } from './text.ts';
import type { CliIo, CommandContext, CommandSpec, OptionSpec, OptionValue } from './types.ts';
import { CLI_NAME, HOMEPAGE, VERSION } from './version.ts';

// Este módulo roda em todo início, inclusive em `--version`. Não importe aqui nada do núcleo nem de um comando:
// o código pesado só entra pelo `load()` do registro.

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
/** A ação precisa de confirmação (`status: confirmation_required`): nada foi feito; a saída traz o resumo e o token. */
export const EXIT_CONFIRM = 3;
/** Recusado pela regra de quem é quem: só o usuário, num terminal interativo, faz isto. */
export const EXIT_HUMAN_ONLY = 4;

/** Códigos de erro que saem com `EXIT_HUMAN_ONLY`. */
const HUMAN_ONLY_CODES: ReadonlySet<string> = new Set(['human_only', 'rule_requires_human']);

/** Variável de ambiente alternativa a `--brain`. */
export const BRAIN_ENV = 'CABECAO_BRAIN';
/** Com `CABECAO_DEBUG=1`, os erros saem com o stack. */
export const DEBUG_ENV = 'CABECAO_DEBUG';

export const GLOBAL_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  brain: { type: 'string', valueName: 'pasta', description: `Pasta do cérebro (ou a variável ${BRAIN_ENV})` },
  json: { type: 'boolean', description: 'Saída estruturada em JSON, para scripts e hooks' },
  as: {
    type: 'string',
    valueName: 'cliente',
    description: 'Roda como o agente <cliente> (só dá o nome para a proveniência; nunca concede nada)',
  },
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
function translateParseError(error: unknown, known: readonly string[] = []): UsageError {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  const option = /'(-{1,2}[^\s'=<]+)/.exec(message)?.[1];
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && option !== undefined) {
    const typed = option.replace(/^-+/, '');
    return new UsageError(`opção desconhecida: ${option}.${didYouMean(typed, known, '--')}`.replace(/\.$/, ''));
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
    throw translateParseError(error, Object.keys(options));
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

/** Largura da ajuda: a do terminal (até 100 colunas, para a leitura), ou 80 sem terminal. */
export function helpWidth(io: Pick<CliIo, 'columns' | 'env'>): number {
  const fromEnv = Number(io.env.COLUMNS);
  const columns = io.columns ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 80);
  return Math.max(40, Math.min(100, columns));
}

/** Tabela de duas colunas que respeita a largura: a descrição quebra alinhada; rótulo longo vai sozinho na linha. */
function table(rows: ReadonlyArray<readonly [string, string]>, width: number): string {
  const labelWidth = Math.min(Math.max(...rows.map(([left]) => left.length)), Math.floor(width / 3));
  const pad = ' '.repeat(2 + labelWidth + 2);
  const lines: string[] = [];
  for (const [left, right] of rows) {
    if (left.length > labelWidth) {
      lines.push(`  ${left}`, ...fill(words(right), width, pad, pad));
    } else lines.push(...fill(words(right), width, `  ${left.padEnd(labelWidth)}  `, pad));
  }
  return lines.join('\n');
}

function optionsTable(options: Readonly<Record<string, OptionSpec>>, width: number): string {
  return table(
    Object.entries(options).map(([name, spec]) => [optionLabel(name, spec), spec.description] as const),
    width,
  );
}

/** As opções globais numa linha, para a ajuda de cada comando (a explicação completa fica em `cabecao --help`). */
const GLOBAL_LINE = `Opções globais: --brain <pasta>, --json, --as <cliente>, -h, -v (veja "${CLI_NAME} --help").`;

function groupedCommands(commands: readonly CommandSpec[], width: number): string[] {
  const used = new Set<string>();
  const lines: string[] = [];
  const rows = (names: readonly string[]) =>
    names.flatMap((name) => {
      const command = commands.find((candidate) => candidate.name === name);
      if (command === undefined) return [];
      used.add(name);
      return [[command.name, command.summary] as const];
    });
  for (const group of GROUPS) {
    const list = rows(group.commands);
    if (list.length === 0) continue;
    lines.push(`${group.title}:`, table(list, width), '');
  }
  const rest = commands.filter((command) => !used.has(command.name));
  if (rest.length > 0)
    lines.push(
      'Outros:',
      table(
        rest.map((c) => [c.name, c.summary] as const),
        width,
      ),
      '',
    );
  return lines;
}

export function generalHelp(commands: readonly CommandSpec[], width = 80): string {
  const lines = [
    `${CLI_NAME} ${VERSION}`,
    'Segundo cérebro pessoal em Markdown e git, para você e seus agentes de IA.',
    '',
    'Uso:',
    `  ${CLI_NAME} <comando> [opções]`,
    `  ${CLI_NAME} <comando> --help`,
    '',
    ...groupedCommands(commands, width),
    'Opções globais:',
    optionsTable(GLOBAL_OPTIONS, width),
    '',
    'Para começar:',
    `  ${CLI_NAME} init <url-do-repositório>   numa máquina nova (sem URL: só local)`,
    `  ${CLI_NAME} doctor                       se algo parecer errado`,
    '',
    reflow(
      `O cérebro usado é o de --brain, senão o de ${BRAIN_ENV}, senão o padrão desta máquina (gravado pelo init), senão a pasta atual, se ela for um cérebro.`,
      width,
    ),
    reflow(
      'Quem roda é você só num terminal interativo e sem sinal de agente no ambiente; em qualquer outro caso, um agente, com as regras do servidor MCP.',
      width,
    ),
    '',
    HOMEPAGE,
  ];
  return `${lines.join('\n')}\n`;
}

export function commandHelp(command: CommandSpec, width = 80): string {
  const hanging = ' '.repeat(4 + CLI_NAME.length + 1 + command.name.length + 1);
  const lines = [
    reflow(`${CLI_NAME} ${command.name}: ${command.summary}`, width),
    '',
    'Uso:',
    ...command.usage.map((line) => wrapLine(`  ${CLI_NAME} ${line}`, width, hanging)),
  ];
  const examples = EXAMPLES[command.name] ?? [];
  if (examples.length > 0) {
    lines.push('', 'Exemplos:', ...examples.map((line) => wrapLine(`  ${line}`, width, '      ')));
  }
  if (command.options !== undefined && Object.keys(command.options).length > 0) {
    lines.push('', 'Opções:', optionsTable(command.options, width));
  }
  lines.push('', reflow(GLOBAL_LINE, width));
  if (command.details !== undefined) lines.push('', reflow(command.details, width));
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
    io.stdout.write(generalHelp(commands, helpWidth(io)));
  }
  return EXIT_OK;
}

function printCommandHelp(io: CliIo, json: boolean, command: CommandSpec): number {
  if (json) {
    const { name, summary, usage, options = {} } = command;
    const examples = EXAMPLES[name] ?? [];
    writeJson(io, { ok: true, command: name, data: { name, summary, usage, examples, options } });
  } else {
    io.stdout.write(commandHelp(command, helpWidth(io)));
  }
  return EXIT_OK;
}

function findCommand(commands: readonly CommandSpec[], name: string): CommandSpec {
  const command = commands.find((candidate) => candidate.name === name);
  if (command === undefined) {
    const suggestion = didYouMean(
      name,
      commands.map((candidate) => candidate.name),
      `${CLI_NAME} `,
    );
    throw new UsageError(`comando desconhecido: ${name}.${suggestion}`.replace(/\.$/, ''));
  }
  return command;
}

function explicitBrain(io: CliIo, values: Values): string | undefined {
  const flag = values.brain;
  if (flag === '') throw new UsageError('a opção --brain precisa de uma pasta');
  const chosen = typeof flag === 'string' ? flag : io.env[BRAIN_ENV];
  return chosen === undefined || chosen === '' ? undefined : resolve(io.cwd, chosen);
}

/** O erro (ou a causa dele) é o de um cérebro de esquema mais novo que este Cabeção (`config_schema_too_new`). */
function schemaTooNew(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 5; depth++) {
    if ((current as { code?: unknown }).code === 'config_schema_too_new') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function reportError(io: CliIo, raw: unknown, command: string | undefined, json: boolean, ownsStdout = false): number {
  // permissão negada, disco só de leitura ou cheio: o que houve e o que fazer, nunca o texto cru do Node
  const error = raw instanceof CliError || raw instanceof UsageError ? raw : (systemError(raw) ?? raw);
  const usage = error instanceof UsageError;
  const expected = usage || error instanceof CliError;
  const debug = io.env[DEBUG_ENV] === '1';
  const message = error instanceof Error ? error.message : String(error);

  io.stderr.write(`${CLI_NAME}: ${message}\n`);
  if (usage) {
    const help = command === undefined ? `${CLI_NAME} --help` : `${CLI_NAME} ${command} --help`;
    io.stderr.write(`Rode ${help} para ver ${command === undefined ? 'o que existe' : 'o uso'}.\n`);
  }
  // um cérebro de versão mais nova: o comando de atualização depende de como ESTE cabecao foi instalado
  const hint =
    error instanceof CliError && schemaTooNew(error)
      ? `Este cérebro é de uma versão mais nova do Cabeção: ${upgradeHint(io)}.`
      : error instanceof CliError
        ? error.hint
        : undefined;
  if (hint !== undefined) io.stderr.write(`${hint}\n`);
  const humanOnly = error instanceof CliError && error.code !== undefined && HUMAN_ONLY_CODES.has(error.code);
  if (debug) {
    if (error instanceof Error && error.stack !== undefined) io.stderr.write(`${error.stack}\n`);
  } else if (!expected) {
    io.stderr.write(`Rode de novo com ${DEBUG_ENV}=1 para ver os detalhes.\n`);
  }

  if (json && !ownsStdout) {
    const code = error instanceof CliError ? error.code : undefined;
    const details = error instanceof CliError ? error.details : undefined;
    writeJson(io, {
      ok: false,
      command: command ?? null,
      error: {
        kind: usage ? 'usage' : 'runtime',
        message,
        ...(code === undefined ? {} : { code }),
        // `next_step` é o nome do mesmo campo nas tools do servidor MCP
        ...(hint === undefined ? {} : { hint, next_step: hint }),
        ...(details === undefined ? {} : { details }),
      },
    });
  }
  return usage ? EXIT_USAGE : humanOnly ? EXIT_HUMAN_ONLY : EXIT_ERROR;
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

    // quem roda (`actor.ts`) e a classe do comando (`access.ts`). Todo comando registrado tem classe (um teste confere);
    // um registro injetado (testes) sem classe roda como memória: abre o cérebro com o ator resolvido, sob as regras dele
    const actor = resolveActor({
      env: io.env,
      terminal: io.terminal !== undefined,
      as: typeof values.as === 'string' ? values.as : undefined,
    });
    if (values.as === '') throw new UsageError('a opção --as precisa do nome do agente');
    const access = accessOf(command.name, positionals) ?? 'memory';
    if (access === 'human' && actor.actor === 'agent') {
      const what = [command.name, ...(positionals[0] === undefined ? [] : [positionals[0]])].join(' ');
      throw new CliError(
        `"${CLI_NAME} ${what}" só roda para o usuário, num terminal interativo; ${actor.explanation}`,
        {
          code: 'human_only',
          hint: `Rode no seu terminal. Nenhuma opção, variável ou configuração muda isso (veja "${CLI_NAME} help").`,
        },
      );
    }
    const terminal = io.terminal;
    const ctx: CommandContext = {
      ...io,
      command: command.name,
      values,
      positionals,
      json,
      brain: explicitBrain(io, values),
      version: VERSION,
      actor,
      // só o usuário recebe pergunta; ela vai direto ao terminal controlador, nunca ao stdin
      prompt: actor.actor === 'human' && terminal !== undefined ? (question) => terminal.prompt(question) : undefined,
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
