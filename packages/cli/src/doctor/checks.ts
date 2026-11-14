// Verificações do `doctor`. Cada uma é uma função pura:
// recebe os fatos já coletados (`facts.ts` faz a parte que lê disco, git e rede) e devolve o resultado com a correção
// sugerida. Assim cada regra é testável sem montar um cérebro de verdade.
import type { ClientId } from '../install-client/clients.ts';
import type { PluginState } from '../install-client/plugin.ts';
import { pluginActive } from '../install-client/plugin.ts';
import type { ClientRegistration } from '../install-client/register.ts';
import type { InstallState } from '../skills/install.ts';
import { formatAge, formatWhen, plural } from '../text.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  /** Identificador estável (`node`, `git`, `remote`...), para scripts. */
  id: string;
  /** Nome curto, em português, mostrado no terminal. */
  title: string;
  status: CheckStatus;
  /** O que foi visto. */
  message: string;
  /** O que fazer, quando há o que fazer. */
  fix?: string;
  /** Detalhes, um por linha (arquivos, linhas que faltam...). */
  items?: string[];
}

/** Trava encontrada em `.cabecao/locks/`. */
export interface LockFact {
  path: string;
  /** Dono gravado no arquivo; `null` se não deu para ler. */
  owner: { pid: number; host: string } | null;
  ageMs: number;
  /** O processo dono existe nesta máquina; `null` quando o dono é de outra máquina ou desconhecido. */
  alive: boolean | null;
}

export type ProbeFact =
  | { kind: 'skipped' }
  | { kind: 'ok'; branches: readonly string[] }
  | { kind: 'failed'; category: string; message: string; detail: string };

export type VisibilityFact =
  | { kind: 'skipped' }
  | { kind: 'checked'; visibility: 'public' | 'private-or-missing' | 'unknown'; provider: string | null; url: string };

export type IndexFact =
  | { kind: 'missing' }
  | {
      kind: 'present';
      rebuilt: string | null;
      schemaVersion: number;
      expectedSchemaVersion: number;
      notes: number;
      lastScanAt: string | null;
    }
  | { kind: 'error'; message: string; fix?: string };

/** Busca por significado (marco 2). */
export type EmbeddingsFact =
  | { kind: 'off' }
  | {
      kind: 'invalid';
      model: string;
      variant: string;
      revision: string | null;
      enabledHere: boolean;
      fake: boolean;
      message: string;
    }
  | {
      kind: 'configured';
      model: string;
      variant: string;
      revision: string | null;
      enabledHere: boolean;
      /** `CABECAO_TEST_FAKE_EMBEDDER=1`: embedder falso de teste. */
      fake: boolean;
      modelDir: string;
      /** `null` no modo de teste ou quando não deu para ler. */
      runtime: {
        installed: boolean;
        upToDate: boolean;
        backend: string | null;
        problem: string | null;
        dir: string;
      } | null;
      modelCached: boolean | null;
      /** Trechos distintos no banco local e quantos estão sem vetor; `null` sem banco ou sem leitura. */
      chunks: number | null;
      pending: number | null;
    };

/** Sync periódico pelo agendador do sistema (`cabecao schedule`). */
export type ScheduleFact =
  | { kind: 'off' }
  | {
      kind: 'on';
      /** `launchd`, `systemd`, `cron` ou `schtasks`. */
      mechanism: string;
      intervalMin: number | null;
      /** O agendador está com a tarefa; `null` quando não deu para consultar. */
      loaded: boolean | null;
      /** Caminhos do comando agendado que não existem mais. */
      missing: readonly string[];
      brain: string | null;
    }
  | { kind: 'error'; message: string };

/** Tudo o que as verificações precisam saber. Os campos `undefined` não foram coletados (dependiam de outro). */
export interface DoctorFacts {
  platform: NodeJS.Platform;
  nodeVersion: string;
  /** Os comandos de atualização e de instalação global, para a forma de instalação detectada (`install-method.ts`). */
  install?: { upgrade: string; global: string; version: string; method: string };
  git: { kind: 'ok'; version: string; supported: boolean; minimum: string } | { kind: 'error'; message: string };
  /** A pasta do cérebro, ou por que não há uma. */
  brain: { kind: 'resolved'; root: string } | { kind: 'unresolved'; message: string; hint?: string };
  /** `.cabecao.json` lido. */
  config?: { kind: 'ok'; schemaVersion: number; supported: number } | { kind: 'error'; message: string; hint?: string };
  machine?: { kind: 'ok'; name: string | null; configPath: string } | { kind: 'error'; message: string };
  repo?: { kind: 'ok'; branch: string | null; headTime: number | null } | { kind: 'error'; message: string };
  remote?: { name: string; url: string; branch: string } | null;
  probe?: ProbeFact;
  visibility?: VisibilityFact;
  gitignore?: { exists: boolean; missing: readonly string[] };
  gitattributes?: { exists: boolean; missing: readonly string[] };
  index?: IndexFact;
  embeddings?: EmbeddingsFact;
  locks?: readonly LockFact[];
  /** `index.lock` do git e a idade dele. */
  gitIndexLock?: { path: string; ageMs: number } | null;
  /** Operação do git pela metade: `merge`, `rebase`, `cherry-pick`, `revert`, `bisect`. */
  gitOperation?: string | null;
  /** O diário do sync existe: uma aplicação foi interrompida. */
  syncJournal?: boolean;
  syncRunning?: boolean;
  lastSync?: { at: string; status: string; message: string } | null;
  conflicts?: readonly { copy: string; original: string; originalExists: boolean }[];
  gpgSign?: boolean;
  /** `explicit: false`: o git inventou o e-mail (não há user.email configurado). */
  identity?: { kind: 'ok'; ident: string; explicit?: boolean } | { kind: 'error'; message: string };
  clients?:
    | { kind: 'skipped' }
    | { kind: 'read'; detected: readonly ClientId[]; registrations: ClientRegistration[]; plugin?: PluginState };
  /** As skills que o Cabeção instalou (`install-skills`). */
  skills?: { kind: 'read'; installs: readonly InstallState[] } | { kind: 'error'; message: string };
  schedule?: ScheduleFact;
}

/** Uma verificação: devolve `null` quando não se aplica (fato não coletado, outro sistema). */
export type Check = (facts: DoctorFacts) => CheckResult | null;

/** Idade a partir da qual uma trava de outra máquina é considerada abandonada (a mesma do núcleo). */
export const LOCK_STALE_MS = 10 * 60_000;
/** O git considera abandonado um `index.lock` sem dono depois de alguns segundos; o sync, depois de 30 s. */
export const GIT_LOCK_STALE_MS = 30_000;
/** Folga entre a última varredura e o último commit antes de o banco ser dado como desatualizado. */
export const INDEX_FRESHNESS_SLACK_MS = 60_000;
/** Limite clássico de caminho no Windows. */
export const WINDOWS_MAX_PATH = 260;
/** Espaço que sobra para pastas e nomes de nota (com cópia de conflito) abaixo do qual o `doctor` avisa. */
export const WINDOWS_PATH_MARGIN = 100;

const REINIT_HINT = 'Rode "cabecao init" (com a URL do repositório, se houver) ou aponte para o cérebro com --brain.';

/**
 * Mesma faixa do bin (`node-version.ts`): `^22.16.0 || >=24.0.0`. Não é importada de lá de propósito: o bin embute
 * aquele arquivo, e um segundo uso faria o bundler separá-lo num pedaço compartilhado, dando ao bin um import
 * estático. Um teste confere que as duas regras concordam.
 */
export function isSupportedNode(version: string): boolean {
  const [major = Number.NaN, minor = Number.NaN] = version.replace(/^v/, '').split('.').map(Number);
  return major === 22 ? minor >= 16 : major >= 24;
}

export const checkNode: Check = (facts) => {
  const problem = isSupportedNode(facts.nodeVersion)
    ? undefined
    : `o Cabeção precisa do Node.js 22.16 ou mais novo, e este é o v${facts.nodeVersion.replace(/^v/, '')}${
        /^v?23\./.test(facts.nodeVersion) ? ' (a linha 23 não serve: falta a busca de texto do SQLite)' : ''
      }`;
  const version = `v${facts.nodeVersion.replace(/^v/, '')}`;
  if (problem !== undefined) {
    return { id: 'node', title: 'Node.js', status: 'fail', message: problem, fix: 'Instale o Node.js 24 (LTS).' };
  }
  const major = Number(version.slice(1).split('.')[0]);
  return {
    id: 'node',
    title: 'Node.js',
    status: 'ok',
    message: major === 22 ? `${version} (funciona; o recomendado é o 24)` : version,
  };
};

const METHOD_TEXT: Readonly<Record<string, string>> = {
  'npm-global': 'instalado com npm -g',
  'pnpm-global': 'instalado com pnpm -g',
  npx: 'rodando pelo npx',
  local: 'instalado num projeto',
  plugin: 'o do plugin do Claude Code',
  source: 'rodando do código-fonte',
  unknown: 'instalação não identificada',
};

export const checkVersion: Check = (facts) => {
  const { install } = facts;
  if (install === undefined) return null;
  return {
    id: 'version',
    title: 'Cabeção',
    status: 'ok',
    message: `${install.version} (${METHOD_TEXT[install.method] ?? install.method}); para atualizar: ${install.upgrade}`,
  };
};

export const checkGit: Check = (facts) => {
  const { git } = facts;
  if (git.kind === 'error') {
    return {
      id: 'git',
      title: 'git',
      status: 'fail',
      message: git.message,
      fix: 'Instale o git: no macOS, "xcode-select --install" (ou "brew install git"); no Linux, pelo gerenciador de pacotes; no Windows, https://git-scm.com. Depois abra um terminal novo.',
    };
  }
  if (!git.supported) {
    return {
      id: 'git',
      title: 'git',
      status: 'fail',
      message: `${git.version} é mais antigo que o mínimo (${git.minimum})`,
      fix: `Atualize o git para ${git.minimum} ou mais novo (https://git-scm.com).`,
    };
  }
  return { id: 'git', title: 'git', status: 'ok', message: git.version };
};

export const checkBrain: Check = (facts) => {
  if (facts.brain.kind === 'unresolved') {
    return {
      id: 'brain',
      title: 'Cérebro',
      status: 'fail',
      message: facts.brain.message,
      fix: facts.brain.hint ?? REINIT_HINT,
    };
  }
  const { config } = facts;
  if (config === undefined) return null;
  if (config.kind === 'error') {
    return { id: 'brain', title: 'Cérebro', status: 'fail', message: config.message, fix: config.hint ?? REINIT_HINT };
  }
  if (facts.repo?.kind === 'error') {
    return { id: 'brain', title: 'Cérebro', status: 'fail', message: facts.repo.message, fix: REINIT_HINT };
  }
  return {
    id: 'brain',
    title: 'Cérebro',
    // esquema anterior: o cérebro funciona, mas há migração pendente (`cabecao upgrade`)
    status: config.schemaVersion < config.supported ? 'warn' : 'ok',
    message: `${facts.brain.root} (esquema ${config.schemaVersion}${config.schemaVersion === config.supported ? '' : `; esta versão do Cabeção usa o ${config.supported}`})`,
    ...(config.schemaVersion < config.supported
      ? { fix: 'Há migração pendente: rode "cabecao sync" e depois "cabecao upgrade".' }
      : {}),
  };
};

export const checkMachine: Check = (facts) => {
  const { machine } = facts;
  if (machine === undefined) return null;
  if (machine.kind === 'error') {
    return {
      id: 'machine',
      title: 'Configuração da máquina',
      status: 'fail',
      message: machine.message,
      fix: 'Corrija o arquivo ou apague-o e rode "cabecao init" de novo (o cérebro não é tocado).',
    };
  }
  if (machine.name === null) {
    return {
      id: 'machine',
      title: 'Configuração da máquina',
      status: 'warn',
      message: `ainda não há ${machine.configPath}: os commits e as cópias de conflito usam o nome do computador`,
      fix: 'Rode "cabecao init" (num cérebro que já existe ele só grava o nome desta máquina, com --machine <nome>).',
    };
  }
  return { id: 'machine', title: 'Configuração da máquina', status: 'ok', message: `máquina "${machine.name}"` };
};

export const checkRemote: Check = (facts) => {
  if (facts.remote === undefined) return null;
  if (facts.remote === null) {
    return {
      id: 'remote',
      title: 'Remoto',
      status: 'warn',
      message: 'cérebro só local: nenhum remoto configurado, nada é sincronizado com outras máquinas',
      fix: 'Crie um repositório privado e vazio e, na pasta do cérebro, rode "git remote add origin <url>" e "git push -u origin <branch>"; depois "cabecao sync".',
    };
  }
  const { probe } = facts;
  const where = `${facts.remote.name} (${facts.remote.url})`;
  if (probe === undefined || probe.kind === 'skipped') {
    return { id: 'remote', title: 'Remoto', status: 'ok', message: `${where}; não consultado (--offline)` };
  }
  if (probe.kind === 'failed') {
    const offline = probe.category === 'network';
    return {
      id: 'remote',
      title: 'Remoto',
      status: offline ? 'warn' : 'fail',
      message: probe.message,
      fix: offline
        ? 'Sem rede, o sync guarda tudo em commits locais e envia quando o remoto voltar. Se a rede está boa, confira o endereço com "git remote -v".'
        : probe.category === 'auth'
          ? `O sync roda sem terminal e não pode pedir senha: configure uma chave SSH sem senha (ou com o ssh-agent) ou um token salvo no gerenciador de credenciais, e teste com "git ls-remote ${facts.remote.name}" na pasta do cérebro.`
          : `Confira o endereço ("git remote -v") e o acesso no provedor; teste com "git ls-remote ${facts.remote.name}" na pasta do cérebro.`,
      ...(probe.detail === '' ? {} : { items: probe.detail.split('\n') }),
    };
  }
  if (!probe.branches.includes(facts.remote.branch)) {
    return {
      id: 'remote',
      title: 'Remoto',
      status: 'warn',
      message: `${where} responde sem pedir senha, mas não tem a branch ${facts.remote.branch}`,
      fix: 'Rode "cabecao sync" para enviar a branch.',
    };
  }
  return {
    id: 'remote',
    title: 'Remoto',
    status: 'ok',
    message: `${where} responde sem pedir senha (branch ${facts.remote.branch})`,
  };
};

export const checkVisibility: Check = (facts) => {
  const { visibility } = facts;
  if (visibility === undefined || visibility.kind === 'skipped') return null;
  if (visibility.provider === null) {
    return {
      id: 'visibility',
      title: 'Visibilidade',
      status: 'ok',
      message:
        'não verificável (só dá para conferir em HTTPS de provedor conhecido): confirme no provedor que o repositório é privado',
    };
  }
  if (visibility.visibility === 'public') {
    return {
      id: 'visibility',
      title: 'Visibilidade',
      status: 'warn',
      message: `${visibility.url} parece PÚBLICO: o ${visibility.provider} respondeu a uma leitura sem credenciais`,
      fix: `Torne o repositório privado nas configurações do ${visibility.provider} antes de gravar notas pessoais.`,
    };
  }
  return {
    id: 'visibility',
    title: 'Visibilidade',
    status: 'ok',
    message:
      visibility.visibility === 'unknown'
        ? `não deu para confirmar com o ${visibility.provider} (sem rede?)`
        : `privado (o ${visibility.provider} recusou a leitura sem credenciais)`,
  };
};

function lineFileCheck(
  id: string,
  file: string,
  fact: { exists: boolean; missing: readonly string[] } | undefined,
): CheckResult | null {
  if (fact === undefined) return null;
  if (fact.missing.length === 0)
    return { id, title: file, status: 'ok', message: 'tem as linhas que o Cabeção precisa' };
  return {
    id,
    title: file,
    status: 'warn',
    message: fact.exists
      ? `${fact.missing.length === 1 ? 'falta' : 'faltam'} ${plural(fact.missing.length, 'linha', 'linhas')}`
      : 'o arquivo não existe',
    fix: `Acrescente ao ${file} do cérebro, e faça um commit (ou rode "cabecao sync"):`,
    items: [...fact.missing],
  };
}

export const checkGitignore: Check = (facts) => lineFileCheck('gitignore', '.gitignore', facts.gitignore);
export const checkGitattributes: Check = (facts) =>
  lineFileCheck('gitattributes', '.gitattributes', facts.gitattributes);

export const checkIndex: Check = (facts) => {
  const { index } = facts;
  if (index === undefined) return null;
  const refresh = 'Nada a fazer: qualquer leitura (cabecao status, search, o servidor MCP) atualiza o banco sozinha.';
  if (index.kind === 'missing') {
    return {
      id: 'index',
      title: 'Banco local',
      status: 'warn',
      message: 'ainda não foi montado nesta máquina',
      fix: 'Rode "cabecao status": ele monta o banco a partir das notas.',
    };
  }
  if (index.kind === 'error') {
    return {
      id: 'index',
      title: 'Banco local',
      status: 'fail',
      message: index.message,
      fix:
        index.fix ??
        'Apague a pasta .cabecao/ do cérebro (ela não vai para o git) e rode "cabecao status" para refazer o banco.',
    };
  }
  if (index.rebuilt !== null) {
    return {
      id: 'index',
      title: 'Banco local',
      status: 'warn',
      message:
        index.rebuilt === 'corrupt'
          ? 'estava corrompido e foi recriado vazio agora'
          : index.rebuilt === 'schema_changed'
            ? 'era de outra versão do Cabeção e foi recriado vazio agora'
            : 'foi criado vazio agora',
      fix: refresh,
    };
  }
  if (index.schemaVersion !== index.expectedSchemaVersion) {
    return {
      id: 'index',
      title: 'Banco local',
      status: 'warn',
      message: `esquema ${index.schemaVersion}, esperado ${index.expectedSchemaVersion} (outra versão do Cabeção está usando este cérebro)`,
      fix: `Use a mesma versão do Cabeção em todos os clientes desta máquina (${facts.install?.upgrade ?? 'atualize o Cabeção'}); se o plugin do Claude Code também está instalado, atualize-o junto.`,
    };
  }
  const headTime = facts.repo?.kind === 'ok' ? facts.repo.headTime : null;
  const scanned = index.lastScanAt === null ? Number.NaN : Date.parse(index.lastScanAt);
  // A data do commit tem só segundos, e uma escrita indexa a nota um instante ANTES de fazer o commit dela: a folga
  // evita acusar de desatualizado o banco que acabou de receber a escrita. (O núcleo ainda não grava o último commit
  // indexado, `last_indexed_commit`; com ele a comparação seria exata.)
  if (Number.isNaN(scanned) || (headTime !== null && scanned < headTime * 1000 - INDEX_FRESHNESS_SLACK_MS)) {
    return {
      id: 'index',
      title: 'Banco local',
      status: 'warn',
      message:
        index.lastScanAt === null
          ? 'nunca foi varrido'
          : `a última varredura (${formatWhen(index.lastScanAt)}) é anterior ao último commit`,
      fix: refresh,
    };
  }
  return {
    id: 'index',
    title: 'Banco local',
    status: 'ok',
    message: `em dia com o último commit (${plural(index.notes, 'nota', 'notas')}, varrido em ${formatWhen(index.lastScanAt ?? '')})`,
  };
};

export const checkLocks: Check = (facts) => {
  if (facts.locks === undefined) return null;
  const orphans: string[] = [];
  for (const lock of facts.locks) {
    const dead = lock.alive === false || (lock.alive === null && lock.ageMs > LOCK_STALE_MS);
    if (!dead) continue;
    const who =
      lock.owner === null ? 'dono ilegível' : `processo ${lock.owner.pid} em ${lock.owner.host}, que não existe mais`;
    orphans.push(`${lock.path} (${who})`);
  }
  const gitLock = facts.gitIndexLock;
  if (gitLock != null && gitLock.ageMs > GIT_LOCK_STALE_MS) {
    orphans.push(`${gitLock.path} (do git, de ${formatAge(gitLock.ageMs)} atrás)`);
  }
  if (orphans.length === 0) return { id: 'locks', title: 'Travas', status: 'ok', message: 'nenhuma trava órfã' };
  return {
    id: 'locks',
    title: 'Travas',
    status: 'warn',
    message: `${plural(orphans.length, 'trava', 'travas')} de processo que já terminou`,
    fix: 'Nada a fazer: o próximo "cabecao sync" (ou a próxima escrita) toma as travas órfãs sozinho, inclusive o index.lock do git quando nenhum git está rodando.',
    items: orphans,
  };
};

const ABORT: Readonly<Record<string, string>> = {
  merge: 'git merge --abort',
  rebase: 'git rebase --abort',
  'cherry-pick': 'git cherry-pick --abort',
  revert: 'git revert --abort',
  bisect: 'git bisect reset',
};

export const checkInterrupted: Check = (facts) => {
  if (facts.gitOperation === undefined && facts.syncJournal === undefined && facts.repo === undefined) return null;
  if (facts.gitOperation != null) {
    return {
      id: 'interrupted',
      title: 'Operações interrompidas',
      status: 'fail',
      message: `há um ${facts.gitOperation} do git pela metade na pasta do cérebro: o sync se recusa a continuar`,
      fix: `Termine a operação ou desfaça com "${ABORT[facts.gitOperation] ?? 'git status'}" na pasta do cérebro.`,
    };
  }
  if (facts.repo?.kind === 'ok' && facts.repo.branch === null) {
    return {
      id: 'interrupted',
      title: 'Operações interrompidas',
      status: 'fail',
      message: 'o cérebro está com o HEAD solto (fora de uma branch): o sync se recusa a continuar',
      fix: 'Volte para a branch principal com "git switch <branch>" na pasta do cérebro.',
    };
  }
  if (facts.syncJournal === true && facts.syncRunning !== true) {
    return {
      id: 'interrupted',
      title: 'Operações interrompidas',
      status: 'warn',
      message: 'um sync foi interrompido no meio da aplicação',
      fix: 'Rode "cabecao sync": ele recupera o estado sozinho, sem perder nada.',
    };
  }
  const last = facts.lastSync;
  if (last != null && (last.status === 'error' || last.status === 'blocked')) {
    return {
      id: 'interrupted',
      title: 'Operações interrompidas',
      status: 'warn',
      message: `o último sync (${formatWhen(last.at)}) ${last.status === 'blocked' ? 'foi bloqueado' : 'deu erro'}: ${last.message}`,
      fix: 'Resolva o que a mensagem aponta e rode "cabecao sync" de novo.',
    };
  }
  return { id: 'interrupted', title: 'Operações interrompidas', status: 'ok', message: 'nenhuma' };
};

export const checkConflicts: Check = (facts) => {
  if (facts.conflicts === undefined) return null;
  if (facts.conflicts.length === 0)
    return { id: 'conflicts', title: 'Conflitos', status: 'ok', message: 'nenhum pendente' };
  return {
    id: 'conflicts',
    title: 'Conflitos',
    status: 'warn',
    message: `${plural(facts.conflicts.length, 'cópia', 'cópias')} de conflito esperando você`,
    fix: 'Compare cada cópia com a nota original, junte o que importa na nota e apague a cópia; depois rode "cabecao sync".',
    items: facts.conflicts.map(
      (conflict) =>
        `${conflict.copy} → ${conflict.original}${conflict.originalExists ? '' : ' (a original foi apagada)'}`,
    ),
  };
};

export const checkGpgSign: Check = (facts) => {
  if (facts.gpgSign === undefined) return null;
  if (!facts.gpgSign)
    return { id: 'gpgsign', title: 'Assinatura de commits', status: 'ok', message: 'commit.gpgsign desligado' };
  return {
    id: 'gpgsign',
    title: 'Assinatura de commits',
    status: 'warn',
    message:
      'commit.gpgsign está ligado: os commits do Cabeção saem SEM assinatura, porque a chave poderia pedir senha num processo sem terminal e travar o sync',
    fix: 'Nada a fazer se o provedor não exige commits assinados nesta branch. Se exige, desligue a exigência para o repositório do cérebro.',
  };
};

export const checkIdentity: Check = (facts) => {
  const { identity } = facts;
  if (identity === undefined) return null;
  if (identity.kind === 'error') {
    return {
      id: 'identity',
      title: 'Identidade do git',
      status: 'fail',
      message: `o git não sabe o nome e o e-mail do autor: ${identity.message}`,
      fix: 'Rode git config --global user.name "Seu Nome" e git config --global user.email "voce@exemplo.com".',
    };
  }
  if (identity.explicit === false) {
    return {
      id: 'identity',
      title: 'Identidade do git',
      status: 'warn',
      message: `${identity.ident}: o git inventou este e-mail a partir do usuário e do computador (não há user.email configurado), e ele vai nos commits que o Cabeção envia ao remoto`,
      fix: 'Rode git config --global user.name "Seu Nome" e git config --global user.email "voce@exemplo.com".',
    };
  }
  return { id: 'identity', title: 'Identidade do git', status: 'ok', message: identity.ident };
};

export const checkWindowsPath: Check = (facts) => {
  if (facts.platform !== 'win32' || facts.brain.kind !== 'resolved') return null;
  const length = facts.brain.root.length;
  const margin = WINDOWS_MAX_PATH - length;
  if (margin >= WINDOWS_PATH_MARGIN) {
    return { id: 'windows-path', title: 'Caminho no Windows', status: 'ok', message: `${length} caracteres` };
  }
  return {
    id: 'windows-path',
    title: 'Caminho no Windows',
    status: margin <= 0 ? 'fail' : 'warn',
    message: `o caminho do cérebro tem ${length} caracteres e deixa ${Math.max(margin, 0)} para pastas e nomes de nota, perto do limite de ${WINDOWS_MAX_PATH} do Windows`,
    fix: 'Mova o cérebro para uma pasta mais curta (por exemplo C:\\cabecao) e rode "cabecao init" lá, ou ligue os caminhos longos do Windows (LongPathsEnabled) e "git config --global core.longpaths true".',
  };
};

export const checkClients: Check = (facts) => {
  const { clients } = facts;
  if (clients === undefined || clients.kind === 'skipped') return null;
  if (clients.detected.length === 0) {
    return {
      id: 'clients',
      title: 'Clientes MCP',
      status: 'warn',
      message: 'nenhum cliente de IA encontrado nesta máquina',
      fix: 'Depois de instalar um (Claude Code, Codex, Cursor, VS Code, Antigravity), rode "cabecao install-client --all", ou "cabecao install-client --print" para configurar à mão.',
    };
  }
  const items: string[] = [];
  const pending: string[] = [];
  const gone: string[] = [];
  const viaPlugin = clients.plugin !== undefined && pluginActive(clients.plugin);
  for (const registration of clients.registrations) {
    const states = registration.files.map((file) => file.state);
    for (const file of registration.files) gone.push(...(file.gone ?? []));
    // com o plugin do Claude Code, o servidor vem dele: a falta do registro direto não é problema
    const ok =
      (states.length > 0 && states.every((state) => state === 'current')) ||
      (registration.client === 'claude-code' && viaPlugin && states.every((state) => state === 'missing'));
    const text = registration.files
      .map((file) => {
        const label =
          file.state === 'current'
            ? 'registrado para este cérebro'
            : file.state === 'different'
              ? 'registrado com outra configuração (outro cérebro ou outro caminho)'
              : file.state === 'unreadable'
                ? 'arquivo ilegível'
                : 'não registrado';
        return `${file.path}: ${label}`;
      })
      .join('; ');
    items.push(`${registration.label}: ${text || 'sem arquivo de configuração'}`);
    if (!ok) pending.push(registration.client);
  }
  if (gone.length > 0) {
    return {
      id: 'clients',
      title: 'Clientes MCP',
      status: 'fail',
      message: `o registro aponta para o que não existe mais (${[...new Set(gone)].join(', ')}): o cliente não consegue iniciar o servidor. Acontece quando o Node é removido (nvm, fnm, Volta) ou o Cabeção muda de lugar`,
      fix: `Rode "cabecao install-client ${pending.length > 0 ? pending.join(' ') : '--all'}" e reinicie o cliente.`,
      items,
    };
  }
  if (pending.length === 0) {
    return {
      id: 'clients',
      title: 'Clientes MCP',
      status: 'ok',
      message: `${plural(clients.registrations.length, 'cliente registrado', 'clientes registrados')}`,
      items,
    };
  }
  return {
    id: 'clients',
    title: 'Clientes MCP',
    status: 'warn',
    message: `${pending.length} de ${plural(clients.registrations.length, 'cliente', 'clientes')} sem o registro deste cérebro`,
    fix: `Rode "cabecao install-client ${pending.join(' ')}" e reinicie o cliente.`,
    items,
  };
};

/** O plugin do Cabeção no Claude Code, e o conflito com o registro direto (as tools apareceriam em dobro). */
export const checkClaudePlugin: Check = (facts) => {
  const { clients } = facts;
  if (clients === undefined || clients.kind !== 'read' || clients.plugin === undefined) return null;
  const plugin = clients.plugin;
  if (!plugin.installed) return null;
  const title = 'Plugin do Claude Code';
  const version = plugin.version === null ? '' : ` (versão ${plugin.version})`;
  if (!pluginActive(plugin)) {
    return { id: 'claude-plugin', title, status: 'ok', message: `instalado${version}, mas desligado no Claude Code` };
  }
  const direct = clients.registrations
    .find((registration) => registration.client === 'claude-code')
    ?.files.some((file) => file.state !== 'missing');
  if (direct === true) {
    return {
      id: 'claude-plugin',
      title,
      status: 'warn',
      message: `instalado${version} E o servidor também está registrado direto no Claude Code: o agente vê as tools do Cabeção em dobro`,
      fix: 'Fique com um: "cabecao install-client --remove claude-code" tira o registro direto (o plugin já traz o servidor, o briefing e o sync no fim da sessão).',
    };
  }
  return { id: 'claude-plugin', title, status: 'ok', message: `instalado e ligado${version}` };
};

/** As skills que o Cabeção instalou: em dia com esta versão? */
export const checkSkills: Check = (facts) => {
  const { skills } = facts;
  if (skills === undefined) return null;
  const title = 'Skills do Cabeção';
  if (skills.kind === 'error') {
    return {
      id: 'skills',
      title,
      status: 'warn',
      message: skills.message,
      fix: 'Apague o skills.json da configuração e rode "cabecao install-skills".',
    };
  }
  if (skills.installs.length === 0) {
    return { id: 'skills', title, status: 'ok', message: 'nenhuma instalada (opcional: "cabecao install-skills")' };
  }
  const items = skills.installs.map((install) => {
    const parts = [plural(install.current, 'arquivo em dia', 'arquivos em dia')];
    if (install.outdated > 0) parts.push(`${install.outdated} de versão anterior`);
    if (install.missing > 0) parts.push(`${install.missing} faltando`);
    if (install.modified > 0) parts.push(plural(install.modified, 'alterado por você', 'alterados por você'));
    return `${install.dir} (${install.clients.join(', ')}): ${parts.join(', ')}`;
  });
  const stale = skills.installs.filter((install) => install.outdated > 0 || install.missing > 0);
  if (stale.length > 0) {
    const clients = [...new Set(stale.flatMap((install) => install.clients))];
    return {
      id: 'skills',
      title,
      status: 'warn',
      message: 'há skills desatualizadas ou faltando: o agente pode seguir instruções de outra versão',
      fix: `Rode "cabecao install-skills ${clients.join(' ')}" (o que você alterou fica como está).`,
      items,
    };
  }
  return { id: 'skills', title, status: 'ok', message: 'instaladas e em dia', items };
};

export const checkSchedule: Check = (facts) => {
  const fact = facts.schedule;
  if (fact === undefined) return null;
  const title = 'Sync agendado';
  if (fact.kind === 'off') {
    return {
      id: 'schedule',
      title,
      status: 'ok',
      message: 'desligado (opcional: "cabecao schedule on" sincroniza sozinho a cada 30 min)',
    };
  }
  if (fact.kind === 'error') {
    return {
      id: 'schedule',
      title,
      status: 'warn',
      message: `não consegui ler o agendamento: ${fact.message}`,
      fix: 'Rode "cabecao schedule status" para ver o que está registrado.',
    };
  }
  const every = fact.intervalMin === null ? '' : ` a cada ${fact.intervalMin} min`;
  if (fact.missing.length > 0) {
    return {
      id: 'schedule',
      title,
      status: 'warn',
      message: `registrado${every}, mas o comando agendado aponta para o que não existe mais`,
      items: [...fact.missing],
      fix: `Instale com "${facts.install?.global ?? 'npm i -g cabecao'}" e rode "cabecao schedule on" de novo, ou "cabecao schedule off".`,
    };
  }
  if (fact.loaded === false) {
    return {
      id: 'schedule',
      title,
      status: 'warn',
      message: `registrado${every}, mas o agendador (${fact.mechanism}) não está com a tarefa carregada`,
      fix: 'Rode "cabecao schedule on" para registrar de novo.',
    };
  }
  if (fact.brain !== null && facts.brain.kind === 'resolved' && fact.brain !== facts.brain.root) {
    return {
      id: 'schedule',
      title,
      status: 'warn',
      message: `o sync agendado é de outro cérebro (${fact.brain})`,
      fix: 'O sync agendado usa o cérebro padrão desta máquina; rode "cabecao schedule on" depois de trocar o padrão.',
    };
  }
  return { id: 'schedule', title, status: 'ok', message: `ligado${every} (${fact.mechanism})` };
};

/** Todas as verificações, na ordem em que aparecem. */
const EMBEDDINGS_ON_FIX = 'Rode "cabecao embeddings on" nesta máquina (usa o modelo já escolhido no cérebro).';

export const checkEmbeddings: Check = (facts) => {
  const fact = facts.embeddings;
  if (fact === undefined) return null;
  const title = 'Busca por significado';
  if (fact.kind === 'off') {
    return { id: 'embeddings', title, status: 'ok', message: 'desativada: a busca é por palavra-chave' };
  }
  const model = `${fact.model} (${fact.variant})`;
  if (fact.kind === 'invalid') {
    return {
      id: 'embeddings',
      title,
      status: 'fail',
      message: `o "embedding" do .cabecao.json não vale: ${fact.message}`,
      fix: 'Corrija o campo "embedding" do .cabecao.json, ou rode "cabecao embeddings switch <modelo>".',
    };
  }
  if (!fact.enabledHere) {
    return {
      id: 'embeddings',
      title,
      status: 'ok',
      message: `${model}, desligada nesta máquina ("cabecao embeddings on" religa)`,
    };
  }
  const missing = missingHere(fact);
  if (missing.length > 0) {
    // uma causa só (falta instalar nesta máquina), um aviso só: o runtime, o modelo e os trechos sem vetor viram itens
    return {
      id: 'embeddings',
      title,
      status: 'warn',
      message: `${model} está ligada no cérebro, mas falta nesta máquina: a busca aqui é só por palavra-chave`,
      fix: EMBEDDINGS_ON_FIX,
      items: missing,
    };
  }
  if (fact.fake)
    return {
      id: 'embeddings',
      title,
      status: 'warn',
      message: `${model} com o embedder FALSO de teste`,
      fix: 'Tire a variável CABECAO_TEST_FAKE_EMBEDDER do ambiente.',
    };
  if (fact.revision === null) {
    return {
      id: 'embeddings',
      title,
      status: 'warn',
      message: `${model}, sem revisão fixada: cada máquina baixa o que estiver em main no Hugging Face`,
      fix: 'Nada urgente; um "cabecao embeddings switch" para o mesmo modelo grava a revisão.',
    };
  }
  return { id: 'embeddings', title, status: 'ok', message: `${model}, revisão ${fact.revision.slice(0, 12)}` };
};

/** O que falta nesta máquina para a busca por significado (runtime, modelo), ou nada. */
function missingHere(fact: Extract<EmbeddingsFact, { kind: 'configured' }>): string[] {
  if (fact.fake || fact.runtime === null) return [];
  const missing: string[] = [];
  if (!fact.runtime.installed) {
    missing.push(`runtime não instalado${fact.runtime.problem === null ? '' : ` (${fact.runtime.problem})`}`);
  }
  if (fact.modelCached === false) missing.push(`modelo ${fact.model} não baixado`);
  if (missing.length === 0) return [];
  if (fact.pending !== null && fact.chunks !== null && fact.pending > 0) {
    missing.push(`${fact.pending} de ${fact.chunks} trechos sem vetor`);
  }
  if (fact.revision === null) missing.push('sem revisão fixada do modelo (nada urgente)');
  return missing;
}

export const checkEmbeddingsRuntime: Check = (facts) => {
  const fact = facts.embeddings;
  if (fact?.kind !== 'configured' || !fact.enabledHere || fact.fake || missingHere(fact).length > 0) return null;
  const title = 'Runtime de embeddings';
  const runtime = fact.runtime;
  if (runtime === null) {
    return {
      id: 'embeddings-runtime',
      title,
      status: 'warn',
      message: 'não consegui ler o estado do runtime',
      fix: EMBEDDINGS_ON_FIX,
    };
  }
  if (!runtime.installed) {
    return {
      id: 'embeddings-runtime',
      title,
      status: 'warn',
      message: `não instalado nesta máquina${runtime.problem === null ? '' : ` (${runtime.problem})`}: a busca aqui é só por palavra-chave`,
      fix: EMBEDDINGS_ON_FIX,
    };
  }
  if (!runtime.upToDate) {
    return {
      id: 'embeddings-runtime',
      title,
      status: 'warn',
      message: 'instalado com outra versão ou para outro sistema',
      fix: EMBEDDINGS_ON_FIX,
    };
  }
  return { id: 'embeddings-runtime', title, status: 'ok', message: `${runtime.backend ?? '?'} em ${runtime.dir}` };
};

export const checkEmbeddingsModel: Check = (facts) => {
  const fact = facts.embeddings;
  if (fact?.kind !== 'configured' || !fact.enabledHere || fact.fake || fact.modelCached === null) return null;
  if (missingHere(fact).length > 0) return null;
  return fact.modelCached
    ? { id: 'embeddings-model', title: 'Modelo de embeddings', status: 'ok', message: `${fact.model} baixado` }
    : {
        id: 'embeddings-model',
        title: 'Modelo de embeddings',
        status: 'warn',
        message: `${fact.model} não está baixado nesta máquina`,
        fix: EMBEDDINGS_ON_FIX,
      };
};

export const checkEmbeddingsPending: Check = (facts) => {
  const fact = facts.embeddings;
  if (fact?.kind !== 'configured' || fact.pending === null || fact.chunks === null) return null;
  if (fact.enabledHere && missingHere(fact).length > 0) return null;
  const title = 'Trechos sem embedding';
  if (fact.pending === 0)
    return { id: 'embeddings-pending', title, status: 'ok', message: `todos os ${fact.chunks} trechos têm vetor` };
  return {
    id: 'embeddings-pending',
    title,
    status: 'warn',
    message: `${fact.pending} de ${fact.chunks} trechos sem embedding: concorrem só pela palavra-chave`,
    fix: fact.enabledHere
      ? 'Rode "cabecao sync" (calcula o que falta e traz o que outras máquinas calcularam) ou "cabecao embeddings on".'
      : 'Esta máquina está com a busca por significado desligada; outra máquina calcula no próximo sync dela.',
  };
};

export const CHECKS: readonly Check[] = [
  checkVersion,
  checkNode,
  checkGit,
  checkBrain,
  checkMachine,
  checkIdentity,
  checkGpgSign,
  checkRemote,
  checkVisibility,
  checkGitignore,
  checkGitattributes,
  checkIndex,
  checkEmbeddings,
  checkEmbeddingsRuntime,
  checkEmbeddingsModel,
  checkEmbeddingsPending,
  checkLocks,
  checkInterrupted,
  checkConflicts,
  checkWindowsPath,
  checkClients,
  checkClaudePlugin,
  checkSkills,
  checkSchedule,
];

export interface DoctorReport {
  brain: string | null;
  checks: CheckResult[];
  summary: Record<CheckStatus, number>;
  /** Próximos passos opcionais ainda pendentes (só no `doctor`; o `init` mostra os dele). */
  optional?: { id: string; command: string; why: string }[];
}

/** Roda as verificações sobre os fatos e resume. */
export function evaluate(facts: DoctorFacts, checks: readonly Check[] = CHECKS): DoctorReport {
  const results = checks.map((check) => check(facts)).filter((result): result is CheckResult => result !== null);
  const summary: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0 };
  for (const result of results) summary[result.status] += 1;
  return { brain: facts.brain.kind === 'resolved' ? facts.brain.root : null, checks: results, summary };
}

const LABEL: Readonly<Record<CheckStatus, string>> = { ok: 'ok', warn: 'aviso', fail: 'falha' };

/** Texto do relatório para o terminal. `indent` é usado quando o relatório vai dentro da saída do `init`. */
export function renderReport(report: DoctorReport, indent = ''): string {
  const width = Math.max(...report.checks.map((check) => check.title.length));
  const lines: string[] = [];
  for (const check of report.checks) {
    lines.push(`${indent}${LABEL[check.status].padEnd(5)}  ${check.title.padEnd(width)}  ${check.message}`);
    const pad = `${indent}${' '.repeat(7 + width + 2)}`;
    for (const item of check.items ?? []) lines.push(`${pad}- ${item}`);
    if (check.fix !== undefined && check.status !== 'ok') lines.push(`${pad}Correção: ${check.fix}`);
  }
  const { ok, warn, fail } = report.summary;
  lines.push(
    '',
    `${indent}${ok} ok, ${warn} ${warn === 1 ? 'aviso' : 'avisos'}, ${fail} ${fail === 1 ? 'falha' : 'falhas'}.`,
  );
  return lines.join('\n');
}
