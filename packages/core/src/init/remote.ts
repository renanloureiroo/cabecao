/**
 * Conversa com o remoto durante o `init` e o `remote`: validar a URL, olhar o remoto sem clonar, explicar falhas e
 * avisar quando o repositório parece público. Tudo passa por `runGit`: sem terminal, sem pedir senha.
 */
import { tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { GitErrorCategory, GitOpOptions } from '../git/index.ts';
import { GitError, redactCredentials, runGit } from '../git/index.ts';

/** Categoria de falha do `init`: as do git mais a URL que nem chega a ser tentada. */
export type RemoteErrorCategory = GitErrorCategory | 'invalid-url';

export interface RemoteFailure {
  readonly category: RemoteErrorCategory;
  /** Explicação para o usuário, em português. */
  readonly message: string;
  /** Saída do git (sem credenciais), para diagnóstico. */
  readonly detail: string;
}

/** Tempo limite para olhar o remoto (`ls-remote`). */
export const PROBE_TIMEOUT_MS = 30_000;
/** Tempo limite para clonar e enviar: um vault grande, com anexos, leva minutos numa rede lenta. */
export const TRANSFER_TIMEOUT_MS = 10 * 60_000;
/** Prefixo das branches que o próprio Cabeção mantém (branch de índice, no marco 2). */
export const CABECAO_BRANCH_PREFIX = 'cabecao/';

/**
 * Confere se o texto pode ser passado ao git como endereço de repositório. Não diz se o repositório existe; só
 * recusa o que nunca é uma URL válida ou o que seria perigoso: vazio, quebra de linha, começo com `-` (viraria opção
 * do git) e os transportes `ext::` e `fd::` (executam comandos).
 */
export function remoteUrlProblem(url: string): string | null {
  if (url.trim() === '') return 'a URL está vazia';
  if (/[\0\r\n]/.test(url)) return 'a URL tem quebra de linha ou caractere nulo';
  if (url.trim().startsWith('-')) return 'a URL não pode começar com "-"';
  if (/^\s*(ext|fd)::/i.test(url)) return 'os transportes ext:: e fd:: não são aceitos';
  return null;
}

/** `C:\x` ou `C:/x`: caminho do Windows, não o `host:caminho` do scp. */
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/** `true` para URLs com esquema (`https://`, `ssh://`, `file://`) ou no formato do scp (`git@host:caminho`). */
function isNetworkStyle(url: string): boolean {
  if (WINDOWS_DRIVE.test(url)) return false;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[^/\\:]+:/.test(url);
}

/**
 * Endereço como deve ser passado ao git: sem espaço nas pontas e, se for caminho local relativo, absoluto (o git
 * roda em outra pasta, e o `git clone` grava caminhos locais como absolutos). URLs ficam como estão.
 */
export function resolveRemoteArg(url: string, cwd: string = process.cwd()): string {
  const value = url.trim();
  return isNetworkStyle(value) ? value : resolve(cwd, value);
}

/**
 * Forma comparável de um endereço de remoto, para saber se duas URLs apontam para o mesmo repositório: sem espaço,
 * sem credenciais, sem `/` nem `.git` no fim. Caminhos locais viram absolutos (o `git clone` grava assim).
 */
export function normalizeRemoteUrl(url: string, cwd: string = process.cwd()): string {
  let value = url.trim();
  if (!isNetworkStyle(value)) value = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  value = value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]+@/i, '$1');
  return value.replace(/[\\/]+$/, '').replace(/\.git$/i, '');
}

/** Mensagem para o usuário em cada categoria de falha. */
export function remoteFailureMessage(category: RemoteErrorCategory, url: string): string {
  const shown = redactCredentials(url);
  switch (category) {
    case 'invalid-url':
      return `"${shown}" não é um endereço de repositório git que dê para usar.`;
    case 'auth':
      return `Sem permissão para acessar ${shown}. O Cabeção usa as credenciais que o seu git já usa (chave SSH, token salvo, gerenciador de credenciais) e nunca pede senha. Teste no terminal: git ls-remote ${shown}`;
    case 'network':
      return `Não consegui falar com o servidor de ${shown}: sem rede, endereço errado ou tempo esgotado.`;
    case 'not-found':
      return `Não achei um repositório git em ${shown}. Confira o endereço e se você tem acesso a ele.`;
    case 'rejected':
      return `O servidor de ${shown} recusou o envio (histórico diferente ou regra do servidor, como branch protegida).`;
    default:
      return `O git não conseguiu usar o repositório ${shown}.`;
  }
}

/** Converte uma falha do git numa falha explicada. Erros que não são do git sobem como estão. */
export function describeRemoteFailure(error: unknown, url: string): RemoteFailure {
  if (!(error instanceof GitError)) throw error;
  const category = error.category;
  const detail = redactCredentials(error.stderr.trim() || error.message)
    .split('\n')
    .slice(-6)
    .join('\n');
  return { category, message: remoteFailureMessage(category, url), detail };
}

export interface RemoteProbe {
  /** Branches do remoto (sem `refs/heads/`), fora as do próprio Cabeção. */
  readonly branches: readonly string[];
  /** Nenhuma branch: remoto vazio. */
  readonly empty: boolean;
  /**
   * Branch principal: a apontada pelo `HEAD` do remoto; se ela não existir, `main`, `master` ou `trunk`, nessa
   * ordem; senão a primeira em ordem alfabética. `null` num remoto vazio.
   */
  readonly defaultBranch: string | null;
  /** Para onde o `HEAD` do remoto aponta, mesmo que a branch não exista. */
  readonly headTarget: string | null;
}

/** Interpreta a saída de `git ls-remote --symref`. Função pura. */
export function parseLsRemote(stdout: string): RemoteProbe {
  let headTarget: string | null = null;
  const branches: string[] = [];
  for (const line of stdout.split('\n')) {
    const [left, right] = line.split('\t');
    if (left === undefined || right === undefined) continue;
    if (left.startsWith('ref: ') && right === 'HEAD') {
      const target = left.slice(5).trim();
      if (target.startsWith('refs/heads/')) headTarget = target.slice('refs/heads/'.length);
      continue;
    }
    if (right.startsWith('refs/heads/')) {
      const name = right.slice('refs/heads/'.length);
      if (!name.startsWith(CABECAO_BRANCH_PREFIX)) branches.push(name);
    }
  }
  branches.sort();
  let defaultBranch: string | null = null;
  if (headTarget !== null && branches.includes(headTarget)) defaultBranch = headTarget;
  defaultBranch ??= ['main', 'master', 'trunk'].find((name) => branches.includes(name)) ?? branches[0] ?? null;
  return { branches, empty: branches.length === 0, defaultBranch, headTarget };
}

/**
 * Olha o remoto sem clonar (`git ls-remote --symref`). Lança `GitError` quando o remoto não responde; a categoria
 * (`auth`, `network`, `not-found`...) diz por quê.
 */
export async function probeRemote(url: string, options: GitOpOptions & { cwd?: string } = {}): Promise<RemoteProbe> {
  const { cwd = tmpdir(), ...rest } = options;
  const { stdout } = await runGit(['ls-remote', '--symref', '--', url], {
    timeoutMs: PROBE_TIMEOUT_MS,
    ...rest,
    cwd,
  });
  return parseLsRemote(stdout);
}

/** Provedores conhecidos, pelo nome do host. A verificação de público só é feita neles. */
export const KNOWN_GIT_PROVIDERS: Readonly<Record<string, string>> = {
  'github.com': 'GitHub',
  'gitlab.com': 'GitLab',
  'bitbucket.org': 'Bitbucket',
  'codeberg.org': 'Codeberg',
  'gitea.com': 'Gitea',
  'git.sr.ht': 'SourceHut',
  'dev.azure.com': 'Azure DevOps',
};

/**
 * Nome do provedor quando a URL é HTTPS de um provedor conhecido, senão `null`. Só aí dá para saber, sem API, se o
 * repositório é público: basta tentar ler sem credenciais. Em SSH o acesso sempre depende da chave.
 */
export function knownHttpsProvider(url: string): string | null {
  const match = /^https:\/\/(?:[^/@\s]+@)?([^/:\s]+)(?::\d+)?\//i.exec(url.trim());
  const host = match?.[1]?.toLowerCase();
  if (host === undefined) return null;
  return KNOWN_GIT_PROVIDERS[host.replace(/^www\./, '')] ?? null;
}

export type RemoteVisibility = 'public' | 'private-or-missing' | 'unknown';

export interface VisibilityCheck {
  readonly visibility: RemoteVisibility;
  /** Provedor reconhecido, ou `null` quando a URL não é HTTPS de um provedor conhecido (aí nada é consultado). */
  readonly provider: string | null;
}

/** Leitura anônima: `true` se o servidor respondeu; senão a categoria da falha. */
export type AnonymousReader = (url: string) => Promise<true | GitErrorCategory>;

/**
 * Tenta ler o remoto sem nenhuma credencial: sem usuário na URL, sem gerenciador de credenciais (`credential.helper`
 * vazio zera a lista), sem cabeçalho extra. Um `~/.netrc` ainda seria usado pelo curl; nesse caso raro o aviso pode
 * não aparecer.
 */
export const anonymousLsRemote: AnonymousReader = async (url) => {
  const clean = url.trim().replace(/^(https?:\/\/)[^/@]+@/i, '$1');
  try {
    await runGit(['-c', 'credential.helper=', '-c', 'http.extraHeader=', 'ls-remote', '--', clean, 'HEAD'], {
      cwd: tmpdir(),
      timeoutMs: 15_000,
    });
    return true;
  } catch (error) {
    if (error instanceof GitError) return error.category;
    throw error;
  }
};

/**
 * Diz se um remoto HTTPS de provedor conhecido parece público. Para qualquer outra URL devolve `unknown` sem rede.
 * `read` existe para os testes trocarem a leitura anônima por uma simulada.
 */
export async function checkRemoteVisibility(
  url: string,
  read: AnonymousReader = anonymousLsRemote,
): Promise<VisibilityCheck> {
  const provider = knownHttpsProvider(url);
  if (provider === null) return { visibility: 'unknown', provider: null };
  const outcome = await read(url);
  if (outcome === true) return { visibility: 'public', provider };
  if (outcome === 'auth' || outcome === 'not-found') return { visibility: 'private-or-missing', provider };
  return { visibility: 'unknown', provider };
}

/** Texto do aviso de repositório público. */
export function publicRemoteWarning(url: string, provider: string): string {
  return `O repositório ${redactCredentials(url)} parece público: o ${provider} respondeu a uma leitura sem credenciais, então qualquer pessoa pode ler o que for enviado. Torne-o privado antes de gravar notas pessoais.`;
}
