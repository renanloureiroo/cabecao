/** Peças comuns ao `init` e ao `remote`: desfazer, preparar a pasta, gravar o modelo, fazer o commit, configurar. */
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import type { GitOpOptions } from '../git/index.ts';
import { commitPaths, formatCommitMessage, runGit } from '../git/index.ts';
import type { MachineConfig } from '../util/index.ts';
import {
  ConfigError,
  configDir,
  configFilePath,
  defaultMachineName,
  isValidMachineName,
  readMachineConfig,
  sanitizeMachineName,
  ulid,
  writeFileAtomic,
  writeMachineConfig,
} from '../util/index.ts';
import type { BrainConfig } from '../vault/index.ts';
import { mergeGitattributes, mergeGitignore } from './merge-lines.ts';
import { PROBE_TIMEOUT_MS, parseLsRemote } from './remote.ts';
import type { TemplateFile } from './template.ts';
import { GITATTRIBUTES, GITIGNORE, REQUIRED_GITATTRIBUTES_LINES, REQUIRED_GITIGNORE_LINES } from './template.ts';

/** Códigos dos avisos do `init` e do `remote`. Nenhum aviso impede a operação. */
export type InitWarningCode =
  /** A URL é HTTPS de um provedor conhecido e o repositório respondeu a uma leitura sem credenciais. */
  | 'public-remote'
  /** Depois do envio, o `HEAD` do remoto aponta para outra branch (o servidor não informou a branch padrão). */
  | 'remote-head-mismatch'
  /** A branch local foi renomeada para o nome que o remoto usa. */
  | 'branch-renamed'
  /** O vault já tinha `AGENTS.md`; as regras do Cabeção não foram escritas nele. */
  | 'agents-md-kept'
  /** O vault já tinha `CLAUDE.md` sem importar o `AGENTS.md`. */
  | 'claude-md-kept'
  /** O vault já tinha um `index.md` próprio; o catálogo do Cabeção vai para outro arquivo. */
  | 'index-md-kept'
  /** O vault já tinha um `log.md` que não é o diário do Cabeção; as linhas do diário serão acrescentadas nele. */
  | 'log-md-kept'
  /** O vault tem notas soltas na raiz; a raiz inteira virou pasta de notas. */
  | 'root-notes'
  /** O nome de máquina informado não era válido e foi ajustado. */
  | 'machine-name-adjusted'
  /** Esta máquina tinha outro cérebro padrão, que foi trocado por este. */
  | 'default-brain-replaced'
  /** A configuração da máquina estava ilegível e foi regravada. */
  | 'machine-config-unreadable'
  /** O cérebro tem commits locais que ainda não foram enviados. */
  | 'unpushed-commits'
  /** Um gancho `afterInit` falhou; o cérebro está pronto mesmo assim. */
  | 'hook-failed';

export interface InitWarning {
  readonly code: InitWarningCode;
  readonly message: string;
}

/** Ações de desfazer, executadas na ordem inversa. Erros ao desfazer não escondem o erro original. */
export class Rollback {
  #actions: (() => Promise<void>)[] = [];
  readonly problems: string[] = [];

  add(action: () => Promise<void>): void {
    this.#actions.push(action);
  }

  /** Desfaz tudo o que foi registrado. Pode ser chamada mais de uma vez; a segunda não faz nada. */
  async run(): Promise<void> {
    const actions = this.#actions.reverse();
    this.#actions = [];
    for (const action of actions) {
      try {
        await action();
      } catch (error) {
        this.problems.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  /** Esquece as ações: a operação foi concluída e nada mais deve ser desfeito. */
  commit(): void {
    this.#actions = [];
  }
}

/** Remoção que aguenta os arquivos somente leitura do git no Windows e antivírus segurando arquivos. */
export function removeTree(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

export type TargetState = { kind: 'missing' } | { kind: 'empty' } | { kind: 'occupied'; isFile: boolean };

/** Situação da pasta de destino: não existe, existe vazia ou já tem algo. */
export async function inspectTarget(root: string): Promise<TargetState> {
  try {
    const st = await stat(root);
    if (!st.isDirectory()) return { kind: 'occupied', isFile: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  return (await readdir(root)).length === 0 ? { kind: 'empty' } : { kind: 'occupied', isFile: false };
}

/**
 * Cria a pasta de destino (e as pastas acima que faltarem) e devolve como desfazer: apaga a pasta mais alta que foi
 * criada aqui ou, se a pasta já existia vazia, só o que for posto dentro dela.
 */
export async function prepareTarget(root: string): Promise<() => Promise<void>> {
  let topCreated: string | null = null;
  for (let current = root; ; current = dirname(current)) {
    try {
      await lstat(current);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      topCreated = current;
      if (current === parse(current).root) break;
    }
  }
  await mkdir(root, { recursive: true });
  if (topCreated !== null) {
    const created = topCreated;
    return () => removeTree(created);
  }
  return async () => {
    for (const name of await readdir(root)) await removeTree(join(root, name));
  };
}

/** Raiz real do repositório que contém `dir`, ou `null` fora de um repositório. */
export async function gitTopLevel(dir: string, options: GitOpOptions = {}): Promise<string | null> {
  try {
    const result = await runGit(['rev-parse', '--show-toplevel'], { ...options, cwd: dir, allowFailure: true });
    if (result.exitCode !== 0) return null;
    return await realpath(result.stdout.trim());
  } catch {
    return null;
  }
}

/** `true` quando `dir` é a raiz (e não uma subpasta) de um repositório git. */
export async function isRepoRoot(dir: string, options: GitOpOptions = {}): Promise<boolean> {
  const top = await gitTopLevel(dir, options);
  if (top === null) return false;
  try {
    return top === (await realpath(dir));
  } catch {
    return false;
  }
}

export interface AppliedFiles {
  /** Arquivos que não existiam e foram criados. */
  readonly created: string[];
  /** Arquivos que já existiam e receberam linhas no fim (`.gitignore`, `.gitattributes`). */
  readonly merged: string[];
  /** Arquivos do modelo que já existiam e ficaram como estavam. */
  readonly kept: string[];
}

const absolutePath = (root: string, rel: string): string => join(root, ...rel.split('/'));

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/**
 * Grava os arquivos do modelo sem nunca sobrescrever o que já existe: arquivo novo é criado; `.gitignore` e
 * `.gitattributes` existentes recebem só as linhas que faltam; qualquer outro arquivo existente fica como está.
 */
export async function applyTemplateFiles(root: string, files: readonly TemplateFile[]): Promise<AppliedFiles> {
  const applied: AppliedFiles = { created: [], merged: [], kept: [] };
  for (const file of files) {
    const target = absolutePath(root, file.path);
    const current = await readIfExists(target);
    if (current === null) {
      await writeFileAtomic(target, file.content, { ifUnchangedSince: null });
      applied.created.push(file.path);
      continue;
    }
    const merge =
      file.path === GITIGNORE
        ? mergeGitignore(current, REQUIRED_GITIGNORE_LINES)
        : file.path === GITATTRIBUTES
          ? mergeGitattributes(current, REQUIRED_GITATTRIBUTES_LINES)
          : null;
    if (merge !== null && merge.added.length > 0) {
      await writeFileAtomic(target, merge.content);
      applied.merged.push(file.path);
    } else {
      applied.kept.push(file.path);
    }
  }
  return applied;
}

/** O commit vai precisar de autor; sem nome e e-mail configurados, o `git commit` falharia no meio. */
export class GitIdentityError extends Error {
  readonly code = 'EGITIDENTITY';

  constructor(cause?: unknown) {
    super(
      'o git desta máquina não tem nome e e-mail de autor configurados, e o Cabeção faz commits com a sua identidade. Rode no terminal: git config --global user.name "Seu Nome" e git config --global user.email "voce@exemplo.com"; depois repita o comando.',
      cause === undefined ? undefined : { cause },
    );
    this.name = 'GitIdentityError';
  }
}

/** Confere que o git sabe quem é o autor (`git var` falha, sem perguntar nada, quando não sabe). */
export async function ensureGitIdentity(repo: string, options: GitOpOptions = {}): Promise<void> {
  for (const name of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const result = await runGit(['var', name], { ...options, cwd: repo, allowFailure: true });
    if (result.exitCode !== 0) throw new GitIdentityError(result.stderr.trim());
  }
}

export interface InitCommitInput extends GitOpOptions {
  readonly config: BrainConfig;
  readonly paths: readonly string[];
  /** Primeira linha do corpo (`init: ...`). As demais listam os arquivos. */
  readonly summary: string;
  readonly machine: string;
  readonly client: string;
  readonly date: Date;
}

/**
 * Commit do `init` no padrão do doc 12: assunto do modelo do cérebro (padrão `vault backup: <data>`), corpo com o
 * resumo e um arquivo por linha, rodapés de operação, máquina e cliente. Sem sessão: não há agente envolvido.
 */
export async function commitInit(repo: string, input: InitCommitInput): Promise<string | null> {
  const paths = [...input.paths].sort();
  const message = formatCommitMessage({
    ...(input.config.commit?.message === undefined ? {} : { subjectTemplate: input.config.commit.message }),
    ...(input.config.commit?.dateFormat === undefined ? {} : { dateFormat: input.config.commit.dateFormat }),
    date: input.date,
    body: [input.summary, ...paths.map((path) => `- ${path}`)],
    trailers: { op: ulid(input.date.getTime()), machine: input.machine, client: input.client },
    action: 'add',
    numFiles: paths.length,
  });
  const options: GitOpOptions = {
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  };
  return commitPaths(repo, paths, message, options);
}

export interface MachinePlan {
  readonly dir: string;
  readonly machine: string;
  /** Configuração válida que já existia, ou `null`. */
  readonly previous: MachineConfig | null;
}

/** Decide o nome da máquina: o informado, senão o que já estava configurado, senão o hostname. */
export async function planMachine(
  options: { machine?: string; configDir?: string },
  warnings: InitWarning[],
): Promise<MachinePlan> {
  const dir = options.configDir ?? configDir();
  let previous: MachineConfig | null = null;
  try {
    previous = await readMachineConfig(dir);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    warnings.push({
      code: 'machine-config-unreadable',
      message: `A configuração da máquina em ${error.path} estava ilegível e será regravada.`,
    });
  }
  let machine = options.machine ?? previous?.machine ?? defaultMachineName();
  if (!isValidMachineName(machine)) {
    const fixed = sanitizeMachineName(machine);
    warnings.push({
      code: 'machine-name-adjusted',
      message: `O nome de máquina "${machine}" virou "${fixed}": só letras minúsculas, dígitos e hífen, até 32 caracteres.`,
    });
    machine = fixed;
  }
  return { dir, machine, previous };
}

/**
 * Grava `machine` e, com `setDefault`, `defaultBrain` na configuração da máquina. Devolve como desfazer (os bytes
 * anteriores voltam exatamente como estavam, ou o arquivo some se não existia).
 */
export async function saveMachineConfig(
  plan: MachinePlan,
  root: string,
  setDefault: boolean,
  warnings: InitWarning[],
): Promise<() => Promise<void>> {
  const path = configFilePath(plan.dir);
  const before = await readIfExists(path);
  const previousBrain = plan.previous?.defaultBrain;
  const defaultBrain = setDefault ? root : previousBrain;
  if (setDefault && previousBrain !== undefined && previousBrain !== root) {
    warnings.push({
      code: 'default-brain-replaced',
      message: `O cérebro padrão desta máquina era ${previousBrain}; agora é ${root}.`,
    });
  }
  const next: MachineConfig = { machine: plan.machine, ...(defaultBrain === undefined ? {} : { defaultBrain }) };
  if (plan.previous !== null && plan.previous.machine === next.machine && previousBrain === defaultBrain) {
    return async () => {};
  }
  await writeMachineConfig(next, plan.dir);
  return async () => {
    if (before === null) await unlink(path).catch(() => {});
    else await writeFile(path, before, 'utf8');
  };
}

/** Opções de git sem `undefined` (por causa de `exactOptionalPropertyTypes`). */
export function gitOptions(options: GitOpOptions, fallbackTimeoutMs?: number): GitOpOptions {
  const timeoutMs = options.timeoutMs ?? fallbackTimeoutMs;
  return {
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

/**
 * Depois de enviar a um remoto que estava vazio, avisa se o `HEAD` dele não aponta para a branch enviada. Um remoto
 * vazio pode ter nascido com outra branch padrão (`trunk` no servidor, `main` aqui); o `HEAD` dele fica apontando
 * para uma branch que não existe e nem aparece no `ls-remote`. Um clone novo feito por outro programa não saberia
 * o que abrir (o `init` do Cabeção sabe: escolhe a branch que existe).
 */
export async function checkRemoteHead(
  root: string,
  branch: string,
  options: GitOpOptions,
  warnings: InitWarning[],
): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await runGit(['ls-remote', '--symref', 'origin'], {
      ...gitOptions(options, PROBE_TIMEOUT_MS),
      cwd: root,
    }));
  } catch {
    return; // é só uma conferência
  }
  const probe = parseLsRemote(stdout);
  const advertisesHead = stdout.split('\n').some((line) => line.endsWith('\tHEAD'));
  if (probe.headTarget === branch || (advertisesHead && probe.headTarget === null)) return;
  const current = probe.headTarget === null ? 'uma branch que não existe' : `a branch "${probe.headTarget}"`;
  warnings.push({
    code: 'remote-head-mismatch',
    message: `A branch padrão do remoto aponta para ${current}, mas o cérebro foi enviado na "${branch}". Escolha "${branch}" como branch padrão no provedor.`,
  });
}
