/**
 * `cabecao init [url]`: instala ou conecta uma máquina só com a URL do repositório (docs/04-sincronizacao.md,
 * "Instalação só com a URL"; docs/08-instalacao-e-operacao.md, "Instalar").
 *
 * Escopo do marco 1: só a branch principal. Montar o índice local, registrar clientes MCP e rodar o `doctor` são
 * trabalho de quem chama; para isso há os ganchos e o resultado diz o que foi feito.
 */
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { GitOpOptions } from '../git/index.ts';
import { assertGitVersion, currentBranch, redactCredentials, runGit } from '../git/index.ts';
import type { BrainConfig } from '../vault/index.ts';
import {
  BRAIN_CONFIG_FILE,
  DEFAULT_INDEX_MD,
  defaultBrainConfig,
  LOG_MD,
  readBrainConfig,
  renderIndexMd,
} from '../vault/index.ts';
import type { RepoDetection, TreeStats } from './detect.ts';
import { detectRepoKind, vaultLayout } from './detect.ts';
import type { RemoteFailure, VisibilityCheck } from './remote.ts';
import {
  checkRemoteVisibility,
  describeRemoteFailure,
  normalizeRemoteUrl,
  PROBE_TIMEOUT_MS,
  probeRemote,
  publicRemoteWarning,
  remoteFailureMessage,
  remoteUrlProblem,
  resolveRemoteArg,
  TRANSFER_TIMEOUT_MS,
} from './remote.ts';
import type { InitWarning, MachinePlan } from './shared.ts';
import {
  applyTemplateFiles,
  checkRemoteHead,
  commitInit,
  ensureGitIdentity,
  gitOptions,
  inspectTarget,
  isRepoRoot,
  planMachine,
  prepareTarget,
  Rollback,
  saveMachineConfig,
} from './shared.ts';
import type { TemplateFile } from './template.ts';
import {
  AGENTS_MD,
  AGENTS_MD_CONTENT,
  brainConfigFileContent,
  brainTemplateFiles,
  CLAUDE_MD,
  GITATTRIBUTES,
  GITIGNORE,
  LOG_MD_CONTENT,
} from './template.ts';

/**
 * O que o `init` fez:
 *
 * - `created`: remoto vazio; estrutura criada, primeiro commit enviado e upstream configurado.
 * - `joined`: o remoto já era um cérebro (segunda máquina); só clonou.
 * - `adopted`: o remoto era um vault de Obsidian ou de Markdown; acrescentou a configuração sem mover nada.
 * - `local`: sem URL; cérebro só nesta máquina, sem remoto.
 * - `already-initialized`: a pasta já é este mesmo cérebro; nada foi alterado.
 * - `refused`: o remoto tem outra coisa (código, por exemplo); nada ficou para trás.
 * - `remote-error`: URL inválida, sem permissão, sem rede ou envio recusado; nada ficou para trás.
 * - `target-not-empty`: a pasta de destino já tem outra coisa; nada foi tocado.
 */
export type InitCase =
  | 'created'
  | 'joined'
  | 'adopted'
  | 'local'
  | 'already-initialized'
  | 'refused'
  | 'remote-error'
  | 'target-not-empty';

/** Etapas, na ordem em que acontecem. Nem todo caso passa por todas. */
export type InitStep = 'probe' | 'clone' | 'detect' | 'scaffold' | 'commit' | 'config' | 'push';

export interface InitHooks {
  /** Chamado antes de cada etapa (para mostrar progresso). Se lançar, o `init` para e desfaz o que criou. */
  readonly onStep?: (step: InitStep) => void | Promise<void>;
  /**
   * Chamado depois de um `init` bem-sucedido (inclusive `already-initialized`): montar o índice local, registrar
   * clientes MCP, rodar o `doctor`. Uma falha aqui não desfaz nada; vira o aviso `hook-failed`.
   */
  readonly afterInit?: (result: InitResult) => void | Promise<void>;
}

export interface InitOptions extends GitOpOptions {
  /** Endereço do repositório. Sem ele, o cérebro é só local. */
  readonly url?: string;
  /** Pasta do cérebro. A CLI usa `~/cabecao` por padrão; aqui é obrigatória. */
  readonly dir: string;
  /** Nome desta máquina. Padrão: o já configurado, senão o hostname. */
  readonly machine?: string;
  /** Pasta da configuração da máquina. Padrão: `configDir()` (respeita `CABECAO_CONFIG_DIR`). */
  readonly configDir?: string;
  /** Torna este cérebro o padrão da máquina. Padrão: `true`. */
  readonly setDefault?: boolean;
  /** Branch de um cérebro só local. Padrão: `init.defaultBranch` do git do usuário, senão `main`. */
  readonly initialBranch?: string;
  /** Valor de `Cabecao-Client` no commit. Padrão: `cli`. */
  readonly client?: string;
  /** Relógio do commit (para testes). */
  readonly now?: () => Date;
  /**
   * Verificação de repositório público (só consulta a rede para HTTPS de provedor conhecido). `false` desliga.
   * Padrão: {@link checkRemoteVisibility}.
   */
  readonly visibilityCheck?: false | ((url: string) => Promise<VisibilityCheck>);
  readonly hooks?: InitHooks;
}

/** Resumo serializável da detecção (sem a lista de arquivos). */
export interface InitDetection {
  readonly kind: RepoDetection['kind'];
  readonly reason: string;
  readonly stats: TreeStats;
}

/** Resultado do `init`. Só tem dados simples: pode ir direto para `JSON.stringify`. */
export interface InitResult {
  /** `true` quando há um cérebro pronto em `root`. */
  readonly ok: boolean;
  readonly case: InitCase;
  /** Explicação do que aconteceu, em português. */
  readonly message: string;
  /** Caminho absoluto do cérebro (ou da pasta pedida, quando não deu certo). */
  readonly root: string;
  /** Branch principal, com o nome que o remoto usa. */
  readonly branch: string | null;
  /** Endereço do remoto, sem credenciais. */
  readonly remote: string | null;
  /** Arquivos criados ou completados pelo `init`, relativos à raiz, com `/`. */
  readonly created: readonly string[];
  /** Um vault existente foi adotado. */
  readonly adopted: boolean;
  /** SHA do commit do `init`, quando houve um. */
  readonly commit: string | null;
  /** O commit foi enviado ao remoto. */
  readonly pushed: boolean;
  /** Nome desta máquina, como ficou gravado. */
  readonly machine: string | null;
  readonly detection: InitDetection | null;
  /** Por que o remoto falhou, nos casos `remote-error`. */
  readonly error: RemoteFailure | null;
  /** Dá para começar só local agora e ligar o remoto depois (com o git: ver `connectLaterStep`). */
  readonly canStartLocal: boolean;
  readonly warnings: readonly InitWarning[];
  /** O que o usuário pode fazer em seguida, em português. */
  readonly nextSteps: readonly string[];
}

/** Arquivo do catálogo num vault adotado que já tem um `index.md` próprio. */
export const ADOPTED_INDEX_MD = 'cabecao-index.md';

const CATALOG_HEADER = renderIndexMd([]).trimEnd();

interface Context {
  readonly root: string;
  readonly options: InitOptions;
  readonly warnings: InitWarning[];
  readonly rollback: Rollback;
  readonly machine: MachinePlan;
  readonly step: (step: InitStep) => Promise<void>;
}

function summarize(detection: RepoDetection): InitDetection {
  return { kind: detection.kind, reason: detection.reason, stats: detection.stats };
}

function makeResult(root: string, fields: Partial<InitResult> & Pick<InitResult, 'ok' | 'case' | 'message'>) {
  const result: InitResult = {
    root,
    branch: null,
    remote: null,
    created: [],
    adopted: false,
    commit: null,
    pushed: false,
    machine: null,
    detection: null,
    error: null,
    canStartLocal: false,
    warnings: [],
    nextSteps: [],
    ...fields,
  };
  return result;
}

const shown = (url: string): string => redactCredentials(url);

/**
 * Como ligar um remoto a um cérebro só local, com o que existe hoje (o comando `cabecao remote` ainda não existe):
 * o git liga e envia, e o `cabecao sync` cuida do resto. É o mesmo texto que a CLI mostra.
 */
export function connectLaterStep(branch: string | null): string {
  return `Para sincronizar com outras máquinas, crie um repositório privado e vazio (em qualquer provedor) e, na pasta do cérebro, rode "git remote add origin <url>" e "git push -u origin ${branch ?? '<branch>'}". Depois disso, "cabecao sync" mantém as máquinas em dia e "cabecao init <url>" instala nas outras.`;
}

/** Recomeçar só local depois de uma falha com o remoto. */
const START_LOCAL_STEP =
  'Ou comece só local agora (cabecao init, sem URL) e ligue um remoto vazio depois: na pasta do cérebro, "git remote add origin <url>", "git push -u origin <branch>" e "cabecao sync".';

function remoteFailureResult(
  ctx: Pick<Context, 'root' | 'warnings'>,
  remote: string,
  failure: RemoteFailure,
  extra: { detection?: InitDetection; tail?: string } = {},
): InitResult {
  return makeResult(ctx.root, {
    ok: false,
    case: 'remote-error',
    message: `${failure.message} ${extra.tail ?? 'Nada foi criado nesta máquina.'}`,
    remote: shown(remote),
    error: failure,
    canStartLocal: true,
    detection: extra.detection ?? null,
    warnings: ctx.warnings,
    nextSteps: [
      ...(failure.category === 'invalid-url' ? [] : [`Confira o acesso no terminal: git ls-remote ${shown(remote)}`]),
      START_LOCAL_STEP,
    ],
  });
}

/** `init.defaultBranch` do git do usuário, se for um nome de branch válido. */
async function configuredDefaultBranch(options: GitOpOptions): Promise<string | null> {
  const result = await runGit(['config', '--get', 'init.defaultBranch'], {
    ...options,
    cwd: tmpdir(),
    allowFailure: true,
  });
  const name = result.exitCode === 0 ? result.stdout.trim() : '';
  return name !== '' && (await isValidBranchName(name, options)) ? name : null;
}

async function isValidBranchName(name: string, options: GitOpOptions): Promise<boolean> {
  if (name.startsWith('-')) return false;
  const result = await runGit(['check-ref-format', '--branch', name], {
    ...options,
    cwd: tmpdir(),
    allowFailure: true,
  });
  return result.exitCode === 0;
}

async function addVisibilityWarning(ctx: Context, url: string): Promise<void> {
  const check = ctx.options.visibilityCheck;
  if (check === false) return;
  try {
    const outcome = await (check ?? ((target: string) => checkRemoteVisibility(target)))(url);
    if (outcome.visibility === 'public' && outcome.provider !== null) {
      ctx.warnings.push({ code: 'public-remote', message: publicRemoteWarning(url, outcome.provider) });
    }
  } catch {
    // é só um aviso: se a verificação falhar, segue sem ele
  }
}

async function originUrl(root: string, options: GitOpOptions): Promise<string | null> {
  const result = await runGit(['remote', 'get-url', 'origin'], { ...options, cwd: root, allowFailure: true });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/** Commits locais à frente do upstream (sem rede); `null` se não há upstream. */
async function unpushedCount(root: string, options: GitOpOptions): Promise<number | null> {
  const result = await runGit(['rev-list', '--count', '@{upstream}..HEAD'], {
    ...options,
    cwd: root,
    allowFailure: true,
  });
  return result.exitCode === 0 ? Number(result.stdout.trim()) : null;
}

type SameBrain = { same: true; origin: string | null } | { same: false; reason: string };

async function checkSameBrain(root: string, remote: string | null, options: GitOpOptions): Promise<SameBrain> {
  if (!(await isRepoRoot(root, options))) return { same: false, reason: 'não é um repositório git' };
  try {
    await readBrainConfig(root);
  } catch {
    return { same: false, reason: `não tem um ${BRAIN_CONFIG_FILE} válido` };
  }
  const origin = await originUrl(root, options);
  if (remote !== null) {
    if (origin === null) {
      return {
        same: false,
        reason:
          'já é um cérebro, mas só local; para ligá-lo a esse remoto (vazio), rode na pasta dele "git remote add origin <url>", "git push -u origin <branch>" e depois "cabecao sync"',
      };
    }
    if (normalizeRemoteUrl(origin, root) !== normalizeRemoteUrl(remote)) {
      return {
        same: false,
        reason: `já é um cérebro, ligado a outro remoto (${shown(origin)}); para trocar, rode na pasta dele "git remote set-url origin <url>" (o novo remoto tem de estar vazio ou ter este mesmo cérebro) e depois "cabecao sync"`,
      };
    }
  }
  return { same: true, origin };
}

async function occupiedTarget(
  root: string,
  remote: string | null,
  isFile: boolean,
  options: InitOptions,
  warnings: InitWarning[],
): Promise<InitResult> {
  const quick = gitOptions(options);
  const check: SameBrain = isFile
    ? { same: false, reason: 'é um arquivo, não uma pasta' }
    : await checkSameBrain(root, remote, quick);
  if (!check.same) {
    return makeResult(root, {
      ok: false,
      case: 'target-not-empty',
      message: `A pasta ${root} já existe e não está vazia: ${check.reason}. Nada foi alterado.`,
      remote: remote === null ? null : shown(remote),
      canStartLocal: false,
      warnings,
      nextSteps: [
        'Escolha com --dir uma pasta que ainda não existe (ou vazia). Para usar um vault do Obsidian que já está nesta máquina, ponha-o num repositório remoto e rode "cabecao init <url>": o cérebro é clonado numa pasta nova.',
      ],
    });
  }
  const machine = await planMachine(options, warnings);
  await saveMachineConfig(machine, root, options.setDefault ?? true, warnings);
  const nextSteps: string[] = [];
  const ahead = await unpushedCount(root, quick);
  if (ahead !== null && ahead > 0) {
    warnings.push({
      code: 'unpushed-commits',
      message: `O cérebro tem ${ahead} commit(s) que ainda não foram enviados ao remoto.`,
    });
    nextSteps.push('Rode cabecao sync para enviar.');
  }
  return makeResult(root, {
    ok: true,
    case: 'already-initialized',
    message: `${root} já é este cérebro; nada foi alterado.`,
    branch: await currentBranch(root, quick),
    remote: check.origin === null ? null : shown(check.origin),
    machine: machine.machine,
    warnings,
    nextSteps,
  });
}

async function runAfterHook(result: InitResult, hooks: InitHooks | undefined): Promise<InitResult> {
  if (hooks?.afterInit === undefined) return result;
  try {
    await hooks.afterInit(result);
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ...result,
      warnings: [
        ...result.warnings,
        { code: 'hook-failed', message: `O cérebro está pronto, mas uma etapa seguinte falhou: ${detail}` },
      ],
    };
  }
}

/**
 * Instala ou conecta esta máquina a um cérebro, um caso por linha da tabela do doc 04.
 *
 * Nunca pede senha (tudo passa por `runGit`), nunca assume o nome da branch principal e, em qualquer falha no meio,
 * desfaz o que criou: a pasta do cérebro e a configuração da máquina voltam a ser como eram. Falhas esperadas
 * (remoto inacessível, conteúdo recusado, pasta ocupada) voltam no resultado com `ok: false`; erros inesperados
 * (git ausente ou antigo, disco cheio, identidade do git não configurada) são lançados, depois de desfazer.
 */
export async function initBrain(options: InitOptions): Promise<InitResult> {
  const root = resolve(options.dir);
  const warnings: InitWarning[] = [];
  await assertGitVersion(gitOptions(options));

  let remote: string | null = null;
  if (options.url !== undefined) {
    const problem = remoteUrlProblem(options.url);
    if (problem !== null) {
      return remoteFailureResult({ root, warnings }, options.url, {
        category: 'invalid-url',
        message: `${remoteFailureMessage('invalid-url', options.url)} (${problem})`,
        detail: problem,
      });
    }
    remote = resolveRemoteArg(options.url);
  }

  const target = await inspectTarget(root);
  if (target.kind === 'occupied') return occupiedTarget(root, remote, target.isFile, options, warnings);

  const ctx: Context = {
    root,
    options,
    warnings,
    rollback: new Rollback(),
    machine: await planMachine(options, warnings),
    step: async (step) => {
      await options.hooks?.onStep?.(step);
    },
  };
  let result: InitResult;
  try {
    result = remote === null ? await createLocal(ctx) : await fromRemote(ctx, remote);
  } catch (error) {
    await ctx.rollback.run();
    throw error;
  }
  ctx.rollback.commit();
  return result.ok ? runAfterHook(result, options.hooks) : result;
}

async function createLocal(ctx: Context): Promise<InitResult> {
  const { root, options } = ctx;
  const quick = gitOptions(options);
  const branch = options.initialBranch ?? (await configuredDefaultBranch(quick)) ?? 'main';
  if (!(await isValidBranchName(branch, quick))) throw new TypeError(`Nome de branch inválido: "${branch}".`);

  await ctx.step('scaffold');
  ctx.rollback.add(await prepareTarget(root));
  await runGit(['init', '--quiet', `--initial-branch=${branch}`, '--', root], { ...quick, cwd: dirname(root) });
  const config = defaultBrainConfig();
  const applied = await applyTemplateFiles(root, brainTemplateFiles({ config }));

  await ctx.step('commit');
  await ensureGitIdentity(root, quick);
  const commit = await commitInit(root, {
    ...quick,
    config,
    paths: applied.created,
    summary: 'init: cérebro criado só nesta máquina',
    machine: ctx.machine.machine,
    client: options.client ?? 'cli',
    date: options.now?.() ?? new Date(),
  });

  await ctx.step('config');
  ctx.rollback.add(await saveMachineConfig(ctx.machine, root, options.setDefault ?? true, ctx.warnings));
  return makeResult(root, {
    ok: true,
    case: 'local',
    message: `Cérebro criado só nesta máquina, em ${root} (branch ${branch}). Nenhum remoto foi ligado.`,
    branch,
    created: applied.created,
    commit,
    machine: ctx.machine.machine,
    warnings: ctx.warnings,
    nextSteps: [connectLaterStep(branch)],
  });
}

interface ScaffoldPlan {
  readonly files: TemplateFile[];
  readonly config: BrainConfig;
}

async function readText(root: string, rel: string): Promise<string | null> {
  try {
    return await readFile(join(root, ...rel.split('/')), 'utf8');
  } catch {
    return null;
  }
}

/** Primeiro arquivo da lista com esse nome, ignorando a caixa (no macOS e no Windows `Index.md` é `index.md`). */
const findPath = (paths: readonly string[], name: string): string | undefined =>
  paths.find((path) => path.toLowerCase() === name.toLowerCase());

/**
 * O que acrescentar a um vault adotado. Nada é movido nem sobrescrito: `.cabecao.json` (com as pastas que já
 * existem), `.gitignore` e `.gitattributes` (mesclados, se existirem) e `AGENTS.md` e `CLAUDE.md` só se faltarem.
 * As pastas do Cabeção, o catálogo e o diário nascem quando forem usados.
 */
async function adoptionPlan(root: string, detection: RepoDetection, warnings: InitWarning[]): Promise<ScaffoldPlan> {
  const paths = detection.paths;
  const layout = vaultLayout(paths);
  if (layout.rootNotes.length > 0) {
    warnings.push({
      code: 'root-notes',
      message: `O vault tem ${layout.rootNotes.length} nota(s) soltas na raiz; a raiz inteira passou a ser pasta de notas.`,
    });
  }

  let indexMd = DEFAULT_INDEX_MD;
  const existingIndex = findPath(paths, DEFAULT_INDEX_MD);
  if (existingIndex !== undefined) {
    const text = (await readText(root, existingIndex)) ?? '';
    if (!text.replace(/\r\n/g, '\n').startsWith(CATALOG_HEADER)) {
      indexMd = ADOPTED_INDEX_MD;
      warnings.push({
        code: 'index-md-kept',
        message: `O ${existingIndex} do vault foi mantido como está; o catálogo gerado pelo Cabeção vai para ${ADOPTED_INDEX_MD}.`,
      });
    }
  }

  const existingLog = findPath(paths, LOG_MD);
  if (existingLog !== undefined) {
    const text = (await readText(root, existingLog)) ?? '';
    if (!text.startsWith(LOG_MD_CONTENT.trimEnd())) {
      warnings.push({
        code: 'log-md-kept',
        message: `O vault já tem um ${existingLog}; o Cabeção vai acrescentar as linhas do diário no fim dele, sem mudar o que já está lá.`,
      });
    }
  }

  const existingAgents = findPath(paths, AGENTS_MD);
  if (existingAgents !== undefined && (await readText(root, existingAgents)) !== AGENTS_MD_CONTENT) {
    warnings.push({
      code: 'agents-md-kept',
      message: `O ${existingAgents} do vault foi mantido; as regras do Cabeção não foram escritas nele (elas também chegam pelas instruções do servidor MCP).`,
    });
  }
  const existingClaude = findPath(paths, CLAUDE_MD);
  if (existingClaude !== undefined && !((await readText(root, existingClaude)) ?? '').includes(`@${AGENTS_MD}`)) {
    warnings.push({
      code: 'claude-md-kept',
      message: `O ${existingClaude} do vault foi mantido; acrescente a linha @${AGENTS_MD} nele para o Claude Code ler as regras do cérebro.`,
    });
  }

  const config: BrainConfig = { ...defaultBrainConfig(), noteDirs: layout.noteDirs, indexMd };
  const template = brainTemplateFiles({ config });
  const wanted = new Set([GITIGNORE, GITATTRIBUTES, AGENTS_MD, CLAUDE_MD]);
  const files = [
    { path: BRAIN_CONFIG_FILE, content: brainConfigFileContent(config) },
    ...template.filter((file) => wanted.has(file.path)),
  ];
  return { files, config };
}

async function fromRemote(ctx: Context, remote: string): Promise<InitResult> {
  const { root, options } = ctx;
  const quick = gitOptions(options);
  const transfer = gitOptions(options, TRANSFER_TIMEOUT_MS);

  await ctx.step('probe');
  let probe: Awaited<ReturnType<typeof probeRemote>>;
  try {
    probe = await probeRemote(remote, gitOptions(options, PROBE_TIMEOUT_MS));
  } catch (error) {
    return remoteFailureResult(ctx, remote, describeRemoteFailure(error, remote));
  }
  await addVisibilityWarning(ctx, remote);

  await ctx.step('clone');
  ctx.rollback.add(await prepareTarget(root));
  try {
    const branchArgs = probe.defaultBranch === null ? [] : ['--branch', probe.defaultBranch];
    await runGit(['clone', '--quiet', '--no-checkout', '--origin', 'origin', ...branchArgs, '--', remote, root], {
      ...transfer,
      cwd: dirname(root),
    });
  } catch (error) {
    const failure = describeRemoteFailure(error, remote);
    await ctx.rollback.run();
    return remoteFailureResult(ctx, remote, failure);
  }

  await ctx.step('detect');
  const detection = await detectRepoKind(root);
  const summary = summarize(detection);
  if (detection.kind === 'other') {
    await ctx.rollback.run();
    return makeResult(root, {
      ok: false,
      case: 'refused',
      message: `${shown(remote)} não parece um cérebro nem um vault de notas: ${detection.reason}. Nada foi criado nesta máquina nem alterado no remoto.`,
      remote: shown(remote),
      detection: summary,
      canStartLocal: true,
      warnings: ctx.warnings,
      nextSteps: ['Use um repositório vazio (de preferência privado) ou um vault de notas Markdown.', START_LOCAL_STEP],
    });
  }
  if (detection.stats.hasCommits) await runGit(['reset', '--quiet', '--hard', 'HEAD'], { ...quick, cwd: root });
  const branch = await currentBranch(root, quick);
  if (branch === null) throw new Error(`o clone de ${shown(remote)} ficou sem branch (HEAD solto)`);

  if (detection.kind === 'brain') {
    await ctx.step('config');
    ctx.rollback.add(await saveMachineConfig(ctx.machine, root, options.setDefault ?? true, ctx.warnings));
    return makeResult(root, {
      ok: true,
      case: 'joined',
      message: `Cérebro existente: clonado em ${root} (branch ${branch}).`,
      branch,
      remote: shown(remote),
      machine: ctx.machine.machine,
      detection: summary,
      warnings: ctx.warnings,
    });
  }

  const adopting = detection.kind === 'markdown-vault';
  await ctx.step('scaffold');
  const plan: ScaffoldPlan = adopting
    ? await adoptionPlan(root, detection, ctx.warnings)
    : { files: brainTemplateFiles(), config: defaultBrainConfig() };
  const applied = await applyTemplateFiles(root, plan.files);
  const changed = [...applied.created, ...applied.merged].sort();

  await ctx.step('commit');
  await ensureGitIdentity(root, quick);
  const commit = await commitInit(root, {
    ...quick,
    config: plan.config,
    paths: changed,
    summary: adopting ? 'init: vault adotado; nenhum arquivo foi movido' : 'init: cérebro criado',
    machine: ctx.machine.machine,
    client: options.client ?? 'cli',
    date: options.now?.() ?? new Date(),
  });

  await ctx.step('config');
  ctx.rollback.add(await saveMachineConfig(ctx.machine, root, options.setDefault ?? true, ctx.warnings));

  await ctx.step('push');
  try {
    await runGit(['push', '--quiet', '--set-upstream', 'origin', branch], { ...transfer, cwd: root });
  } catch (error) {
    const failure = describeRemoteFailure(error, remote);
    await ctx.rollback.run();
    return remoteFailureResult(ctx, remote, failure, {
      detection: summary,
      tail: 'O cérebro não foi criado nesta máquina, e o remoto ficou como estava.',
    });
  }
  // Daqui em diante o remoto já mudou: nada mais é desfeito, e o que falhar vira aviso.
  ctx.rollback.commit();
  await finishPush(ctx, root, branch, probe.empty);

  return makeResult(root, {
    ok: true,
    case: adopting ? 'adopted' : 'created',
    message: adopting
      ? `Vault adotado: ${changed.join(', ')} acrescentados ou completados e enviados na branch ${branch}; nenhuma nota foi movida, renomeada ou alterada.`
      : `Repositório vazio: estrutura do cérebro criada na branch ${branch} e enviada para ${shown(remote)}.`,
    branch,
    remote: shown(remote),
    created: changed,
    adopted: adopting,
    commit,
    pushed: true,
    machine: ctx.machine.machine,
    detection: summary,
    warnings: ctx.warnings,
    nextSteps: [
      // O vault foi CLONADO para `root`: se o Obsidian abre o vault de outra pasta, ele continua abrindo aquela cópia,
      // que não recebe o que os agentes gravam aqui (adotar no lugar, sem clonar, é decisão pendente do dono).
      ...(adopting ? [adoptedVaultStep(root)] : []),
      `Em outra máquina, rode cabecao init ${shown(remote)}.`,
    ],
  });
}

/**
 * O que dizer depois de adotar um vault: o cérebro é a pasta NOVA (um clone do vault), e o Obsidian tem de abrir ela.
 * Exportado para a CLI e os testes usarem o mesmo texto.
 */
export function adoptedVaultStep(root: string): string {
  return `O cérebro é a pasta ${root}, um clone novo do vault. Se o Obsidian abre este vault de outra pasta, ele continua abrindo aquela cópia, que não recebe o que os agentes gravam aqui: no Obsidian, use "Abrir pasta como cofre" (Open folder as vault) e escolha ${root}. Depois de conferir que está tudo aqui, apague a cópia antiga ou deixe de usá-la.`;
}

/** Depois do primeiro envio: grava `refs/remotes/origin/HEAD` (a branch principal fica conhecida sem rede). */
async function finishPush(ctx: Context, root: string, branch: string, wasEmpty: boolean): Promise<void> {
  const quick = gitOptions(ctx.options);
  await runGit(['remote', 'set-head', 'origin', branch], { ...quick, cwd: root, allowFailure: true }).catch(() => {});
  if (wasEmpty) await checkRemoteHead(root, branch, ctx.options, ctx.warnings);
}
