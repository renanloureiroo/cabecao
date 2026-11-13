export type Env = Readonly<Record<string, string | undefined>>;

/** Onde a CLI escreve. `process.stdout` serve; nos testes é um acumulador de texto. */
export interface Writer {
  write(chunk: string): unknown;
}

export interface ExecResult {
  /** Código de saída, ou `null` quando o processo nem chegou a rodar ou morreu por sinal. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Env;
  timeoutMs?: number;
}

/** Roda um programa externo sem shell. É injetado para que nenhum teste execute programa de verdade. */
export type Exec = (file: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

/** Tudo o que a CLI enxerga do processo. É passado por parâmetro: nenhum comando lê `process` direto. */
export interface CliIo {
  /** Argumentos depois do nome do programa (`process.argv.slice(2)`). */
  argv: readonly string[];
  env: Env;
  cwd: string;
  stdout: Writer;
  stderr: Writer;
  platform: NodeJS.Platform;
  /** Pasta do usuário usada quando `HOME`/`USERPROFILE` não estão em `env`. */
  homedir?: string | undefined;
  /** Caminho do executável do Node em uso (`process.execPath`). */
  execPath: string;
  /** Caminho do arquivo do bin que está rodando (`process.argv[1]`), quando conhecido. */
  binPath?: string | undefined;
  exec: Exec;
  /**
   * Pergunta ao usuário e devolve a resposta (sem a quebra de linha), ou `null` se não há terminal interativo. Só
   * existe quando a entrada e a saída são um terminal; nos testes, é injetada.
   */
  prompt?: ((question: string) => Promise<string | null>) | undefined;
  /**
   * Como `prompt`, mas sem mostrar o que é digitado (uma chave de API). Só existe com terminal interativo; nos testes,
   * é injetada.
   */
  promptSecret?: ((question: string) => Promise<string | null>) | undefined;
  /**
   * Passa a tratar Ctrl+C (SIGINT/SIGTERM) como cancelamento: o sinal devolvido aborta, e `dispose` devolve o
   * comportamento normal. Só os comandos longos e canceláveis usam (o `ask`); nos testes, não existe.
   */
  watchInterrupt?: (() => { signal: AbortSignal; dispose(): void }) | undefined;
  /**
   * Lê a entrada padrão até o fim, com teto de tamanho e de tempo (`stdin.ts`). Devolve `null` quando a entrada é um
   * terminal, passa do teto ou não termina no prazo. Só os modos de hook usam (o Claude Code manda um JSON por ali);
   * nos testes, é injetada.
   */
  readStdin?: ((limits: StdinLimits) => Promise<string | null>) | undefined;
  /**
   * Encerra o processo com este código depois de esvaziar a saída. Só o modo de hook usa, para não deixar o Claude Code
   * esperando quando o prazo acaba com uma operação ainda pendurada; nos testes, não existe (ou é um falso).
   */
  exit?: ((code: number) => void) | undefined;
}

export interface StdinLimits {
  maxBytes: number;
  timeoutMs: number;
}

/** Opção de linha de comando: a configuração do `parseArgs` mais o texto que aparece na ajuda. */
export interface OptionSpec {
  type: 'boolean' | 'string';
  short?: string;
  multiple?: boolean;
  description: string;
  /** Nome do valor mostrado na ajuda de uma opção `string`: `--dir <pasta>`. */
  valueName?: string;
}

export type OptionValue = string | boolean | Array<string | boolean> | undefined;

export interface CommandContext extends CliIo {
  /** Nome do comando em execução. */
  command: string;
  /** Opções do comando e as globais, já validadas pelo `parseArgs`. */
  values: Readonly<Record<string, OptionValue>>;
  /** Argumentos posicionais depois do nome do comando. */
  positionals: readonly string[];
  /** `--json`: o comando devolve `data`; o roteador é quem escreve o JSON. */
  json: boolean;
  /**
   * Pasta do cérebro pedida explicitamente (`--brain` ou `CABECAO_BRAIN`), já absoluta. `undefined` quando
   * nada foi pedido: use `resolveBrain(ctx)` de `brain.ts` para cair no cérebro padrão da máquina.
   */
  brain: string | undefined;
  version: string;
}

export interface CommandResult {
  /** Código de saída. Padrão: 0. */
  code?: number;
  /** Com `--json`, vai para stdout dentro de `{ ok, command, data }`. */
  data?: unknown;
  /** Sem `--json`, vai para stdout. */
  text?: string;
}

export type CommandRun = (ctx: CommandContext) => Promise<CommandResult> | CommandResult;

export interface CommandModule {
  run: CommandRun;
}

/**
 * Entrada do registro de comandos. Os metadados ficam no módulo leve (a ajuda não carrega o comando);
 * o código vem por `load`, que tem de ser um `import()` dinâmico para o bundler separar o arquivo.
 */
export interface CommandSpec {
  name: string;
  /** Uma linha, mostrada na lista de comandos. */
  summary: string;
  /** Linhas de uso, sem o prefixo `cabecao`. */
  usage: readonly string[];
  options?: Readonly<Record<string, OptionSpec>>;
  /** Texto livre mostrado no fim de `cabecao <comando> --help`. */
  details?: string;
  /**
   * O comando é dono do stdout (o `mcp` fala o protocolo por lá): o roteador não escreve nada nele, nem o texto,
   * nem o JSON de `--json`, nem o de erro. Mensagens e erros vão só para stderr.
   */
  ownsStdout?: boolean;
  load: () => Promise<CommandModule>;
}
