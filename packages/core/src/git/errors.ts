/**
 * Erros da camada de git e classificação das falhas de rede e de autenticação.
 *
 * A classificação lê o stderr do git (sempre em inglês, porque `runGit` força `LC_ALL=C`) e não depende de
 * nenhum provedor: as mensagens são as do próprio git, do ssh e do curl.
 */

/** Categorias de falha de uma operação com o remoto. */
export type GitErrorCategory = 'auth' | 'network' | 'not-found' | 'rejected' | 'unknown';

export interface GitErrorDetails {
  /** Argumentos passados ao git, sem o binário. Podem conter credenciais se a URL as trouxer. */
  args: readonly string[];
  /** Código de saída; `null` quando o processo não chegou a sair sozinho (tempo limite, sinal, falha ao iniciar). */
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  /** O processo foi morto por estourar o tempo limite. */
  timedOut?: boolean;
  /** Texto que substitui o resumo padrão da mensagem. */
  summary?: string;
  cause?: unknown;
}

/** Esconde `usuario:senha@` e `token@` de URLs http(s) em textos que vão para mensagens e logs. */
export function redactCredentials(text: string): string {
  return text.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1***@');
}

/** Falha ao executar o git: código de saída diferente de zero, tempo limite ou processo que não iniciou. */
export class GitError extends Error {
  override readonly name = 'GitError';
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;

  constructor(details: GitErrorDetails) {
    const stderr = details.stderr ?? '';
    const outcome = details.timedOut
      ? 'tempo limite'
      : details.exitCode === null
        ? `sinal ${details.signal ?? 'desconhecido'}`
        : `código ${details.exitCode}`;
    const summary = details.summary ?? stderr.trim().slice(0, 600);
    const command = redactCredentials(`git ${details.args.join(' ')}`);
    super(
      `${command} falhou (${outcome})${summary ? `: ${redactCredentials(summary)}` : ''}`,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.args = [...details.args];
    this.exitCode = details.exitCode;
    this.signal = details.signal ?? null;
    this.stdout = details.stdout ?? '';
    this.stderr = stderr;
    this.timedOut = details.timedOut ?? false;
  }

  /** Categoria da falha, pela mesma regra de {@link classifyGitError}. */
  get category(): GitErrorCategory {
    return classifyGitError(this);
  }
}

/** O estado do repositório não permite a operação pedida (por exemplo, há mudanças preparadas no índice). */
export class GitStateError extends Error {
  override readonly name = 'GitStateError';
}

// A ordem das regras importa: a política do servidor vem antes de "rejeitado", e "não encontrado" vem antes de
// "sem conexão", porque o ssh sempre acrescenta "Could not read from remote repository" às duas situações.
const POLICY =
  /pre-receive hook declined|protected branch|not allowed to|deletion prohibited|denying ref deletion|deletion of the current branch prohibited|GH006|GH013|push declined/i;
const REJECTED =
  /\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first|stale info|failed to push some refs|incorrect old value|cannot lock ref|failed to update ref|reference already exists/i;
const UNREACHABLE = /Could not resolve|unable to access/i;
const AUTH_FIRST =
  /Permission denied \(publickey|Authentication failed|terminal prompts disabled|could not read Username|could not read Password|Host key verification failed/i;
const DNS =
  /Could not resolve host|Could not resolve hostname|Could not resolve proxy|Name or service not known|nodename nor servname|Temporary failure in name resolution|No address associated with hostname/i;
const NOT_FOUND =
  /Repository not found|does not appear to be a git repository|couldn't find remote ref|No such remote|not found|returned error: 404/i;
const AUTH_REST =
  /HTTP 401|HTTP 403|returned error: 40[13]|Invalid username or (password|token)|Access denied|Permission to \S+ denied|Write access to repository not granted|Permission denied/i;
const CONNECT =
  /Connection refused|Failed to connect|Couldn't connect to server|Connection timed out|Operation timed out|Network is unreachable|No route to host|Could not connect|timed out|Connection reset|Connection closed|kex_exchange|remote end hung up unexpectedly|early EOF|RPC failed|Could not read from remote repository/i;

/**
 * Classifica uma falha de `fetch`, `push`, `clone` ou `ls-remote` a partir do stderr.
 *
 * - `auth`: credencial ausente, errada ou sem permissão; o git quis perguntar e não pôde.
 * - `network`: o servidor não foi alcançado (DNS, conexão recusada, tempo limite).
 * - `not-found`: o remoto, o repositório ou a branch não existem.
 * - `rejected`: o servidor respondeu e recusou o envio (histórico divergente ou regra do servidor).
 * - `unknown`: nenhuma das anteriores.
 */
export function classifyGitError(input: string | GitError): GitErrorCategory {
  if (typeof input !== 'string' && input.timedOut) return 'network';
  const text = typeof input === 'string' ? input : input.stderr;
  if (POLICY.test(text)) return 'rejected';
  if (REJECTED.test(text) && !UNREACHABLE.test(text)) return 'rejected';
  if (AUTH_FIRST.test(text)) return 'auth';
  if (DNS.test(text)) return 'network';
  if (NOT_FOUND.test(text)) return 'not-found';
  if (AUTH_REST.test(text)) return 'auth';
  if (CONNECT.test(text)) return 'network';
  return 'unknown';
}
