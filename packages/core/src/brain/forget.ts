// `forget` (doc 05, "Confirmação de ações destrutivas"; doc 07, "Esquecimento"; ADR 24; marco 4): ARQUIVA uma nota
// em `memory/_archive/` (sai da busca e do `recall`, continua no git; `undo` traz de volta). Nunca apaga.
//
// Confirmação em duas chamadas, que funciona em qualquer cliente:
//   1. `forget({ id, reason })` devolve o resumo do que será arquivado, um `confirm_token` de vida curta e `next_step`;
//   2. `forget({ id, reason, confirm_token })` executa.
// O token não guarda estado em lugar nenhum: é um HMAC-SHA256, com o segredo local da máquina (`.cabecao/confirm.key`),
// sobre a ação, o id e o caminho da nota, o hash do conteúdo ATUAL do arquivo, a sessão e a hora em que vence. Na
// segunda chamada tudo é recalculado: outra nota, a nota alterada depois do resumo, outra sessão, token vencido ou
// adulterado não passam. O token não é barreira humana (o agente pode fazer as duas chamadas); ele garante que a ação
// foi intencional e é a que foi mostrada. Quando o cliente declara elicitação, o servidor MCP pergunta direto ao
// usuário e chama com `userConfirmed` (opção que nunca vem do agente).
//
// O token tem um prefixo próprio (`cbc_ct_`) que o scanner de segredos reconhece: ele nunca é GRAVADO numa nota (o
// agente que tentar copiar o token para um handoff ou uma memória é barrado), e as respostas das tools, que não passam
// pelo scanner, o entregam normalmente.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IndexedNote } from '../db/index.ts';
import { getNote } from '../db/index.ts';
import { isSafeRelativePath, isUlid } from '../util/index.ts';
import { archiveNote, hashContent, isArchivedPath, readNote } from '../vault/index.ts';
import type { BrainContext } from './context.ts';
import { withFreshIndex } from './context.ts';
import type { DataEnvelope } from './envelope.ts';
import { DATA_NOTICE } from './envelope.ts';
import type { IssueOutput } from './errors.ts';
import { BrainError, toBrainError } from './errors.ts';
import { confirmSecret } from './local-state.ts';
import {
  assertAgentMayWrite,
  assertAgentText,
  executeBatch,
  frontmatterTargets,
  invalid,
  isRecord,
  isRuleType,
  ruleRefused,
  sessionOf,
} from './write.ts';

/** Quanto tempo um `confirm_token` vale. */
export const CONFIRM_TOKEN_TTL_MS = 5 * 60_000;
/** Prefixo do `confirm_token`; o scanner de segredos tem uma regra para ele (`cabecao-confirm-token`). */
export const CONFIRM_TOKEN_PREFIX = 'cbc_ct_';
export const FORGET_REASON_MAX_CHARS = 500;

const TOKEN_RE = /^cbc_ct_([0-9a-z]{1,12})_([A-Za-z0-9_-]{43})$/;

export interface ForgetInput {
  /** Id (ULID) da nota, ou o caminho dela. */
  readonly id: string;
  /** Por que esquecer; vai para a cópia arquivada (`forget_reason`) e para o diário. */
  readonly reason: string;
  /** O token devolvido pela primeira chamada. */
  readonly confirm_token?: string;
  readonly session_handle?: string;
}

/** Opções que só quem chama de dentro passa (o servidor MCP, depois de o usuário confirmar por elicitação). */
export interface ForgetOptions {
  readonly userConfirmed?: boolean;
}

export interface ForgetOutput extends DataEnvelope {
  /** `confirmation_required`: nada mudou, falta a segunda chamada; `archived`: arquivada. */
  readonly status: 'confirmation_required' | 'archived';
  readonly note: {
    readonly id: string;
    readonly path: string;
    readonly title: string | null;
    readonly type: string | null;
    readonly scope: string | null;
    readonly trust: string | null;
    readonly origin: string | null;
  };
  /** O que será (ou foi) arquivado, em português. */
  readonly summary: string;
  readonly confirm_token: string | null;
  /** Quando o `confirm_token` vence (ISO 8601). */
  readonly token_expires_at: string | null;
  /** Como foi confirmado: pelo token ou pelo usuário (elicitação). */
  readonly confirmed_by: 'token' | 'user' | null;
  readonly op: string | null;
  readonly commit: string | null;
  readonly archived_path: string | null;
  readonly warnings: readonly IssueOutput[];
  readonly next_step: string;
}

const base64url = (data: Buffer): string => data.toString('base64url');

function signature(secret: Buffer, fields: readonly string[]): string {
  return base64url(createHmac('sha256', secret).update(fields.join('\u0000')).digest());
}

function tokenFields(note: IndexedNote, contentHash: string, session: string, expires: string): string[] {
  return ['forget', 'v1', note.id, note.path, contentHash, session, expires];
}

/** A nota pelo id (ULID) ou pelo caminho. */
async function findNote(ctx: BrainContext, ref: string): Promise<IndexedNote> {
  const byId = isUlid(ref.trim().toUpperCase());
  if (!byId && !isSafeRelativePath(ref)) {
    throw new BrainError('unsafe_path', `caminho recusado: ${JSON.stringify(ref)} não fica dentro do cérebro`);
  }
  const note = await withFreshIndex(ctx, () =>
    getNote(ctx.index, byId ? { id: ref.trim().toUpperCase() } : { path: ref }),
  );
  if (note === null) {
    throw new BrainError('not_found', `nenhuma nota com ${byId ? 'o id' : 'o caminho'} ${ref}`, {
      nextStep: 'Use search ou read para achar a nota e passe o id dela.',
    });
  }
  return note;
}

/** O que um agente não esquece: regra, arquivo de controle ou de instrução, cópia de conflito e fontes de `raw/`. */
function assertMayForget(ctx: BrainContext, note: IndexedNote): void {
  if (note.archived || isArchivedPath(note.path)) {
    throw new BrainError('invalid_argument', `a nota ${note.path} já está arquivada`, {
      nextStep: 'Nada a fazer; para trazê-la de volta, desfaça o forget com undo.',
    });
  }
  if (ctx.actor === 'human') return;
  if (isRuleType(note.type)) throw ruleRefused();
  assertAgentMayWrite(ctx, note.path, 'update');
}

function summaryOf(note: IndexedNote, reason: string, lines: number): string {
  const who = note.origin === null ? 'sem origem registrada' : `origem ${note.origin}`;
  return `Arquivar ${note.type ?? 'nota'} "${note.title ?? note.path}" (${note.path}, ${lines} ${lines === 1 ? 'linha' : 'linhas'}, ${who}, trust ${note.trust ?? '?'}) em memory/_archive/. Motivo: ${reason}. A nota sai da busca e do recall, continua no git e o undo a traz de volta.`;
}

function noteOutput(note: IndexedNote): ForgetOutput['note'] {
  return {
    id: note.id,
    path: note.path,
    title: note.title,
    type: note.type,
    scope: note.scope,
    trust: note.trust,
    origin: note.origin,
  };
}

export async function forget(
  ctx: BrainContext,
  input: ForgetInput,
  options: ForgetOptions = {},
): Promise<ForgetOutput> {
  if (!isRecord(input)) throw invalid('forget precisa de um objeto com id e reason');
  if (typeof input.id !== 'string' || input.id.trim() === '')
    throw invalid('"id" deveria ser o id (ou o caminho) da nota');
  if (typeof input.reason !== 'string' || input.reason.trim() === '') {
    throw invalid('"reason" é obrigatório: diga por que esquecer');
  }
  const reason = input.reason.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (reason.length > FORGET_REASON_MAX_CHARS) {
    throw invalid(`"reason" passa de ${FORGET_REASON_MAX_CHARS} caracteres; resuma`);
  }
  assertAgentText(ctx, reason, '"reason"', 'value');
  assertAgentText(ctx, input.id, '"id"', 'path');
  const session = sessionOf(input.session_handle) ?? '';
  if (input.confirm_token !== undefined && typeof input.confirm_token !== 'string') {
    throw invalid('"confirm_token" deveria ser o texto devolvido pela primeira chamada');
  }

  const note = await findNote(ctx, input.id);
  assertMayForget(ctx, note);
  let read: Awaited<ReturnType<typeof readNote>>;
  try {
    read = await readNote(ctx.root, note.path);
  } catch (error) {
    throw toBrainError(error);
  }
  const contentHash = hashContent(read.text);
  const secret = await confirmSecret(ctx.root);
  const lines = read.text.split('\n').length - (read.text.endsWith('\n') ? 1 : 0);
  const summary = summaryOf(note, reason, lines);

  const token = input.confirm_token;
  const confirmed = options.userConfirmed === true ? 'user' : null;
  if (token === undefined && confirmed === null) {
    const expires = (Math.floor(ctx.now().getTime() / 1000) + CONFIRM_TOKEN_TTL_MS / 1000).toString(36);
    const sig = signature(secret, tokenFields(note, contentHash, session, expires));
    const confirmToken = `${CONFIRM_TOKEN_PREFIX}${expires}_${sig}`;
    return {
      data_notice: DATA_NOTICE,
      status: 'confirmation_required',
      note: noteOutput(note),
      summary,
      confirm_token: confirmToken,
      token_expires_at: new Date(Number.parseInt(expires, 36) * 1000).toISOString(),
      confirmed_by: null,
      op: null,
      commit: null,
      archived_path: null,
      warnings: [],
      next_step: `Mostre o resumo ao usuário. Para arquivar, chame forget de novo com o mesmo id, o mesmo reason${session === '' ? '' : ', o mesmo session_handle'} e confirm_token, em até ${CONFIRM_TOKEN_TTL_MS / 60_000} minutos. Não grave o token em nota nenhuma.`,
    };
  }

  if (token !== undefined) {
    const match = TOKEN_RE.exec(token.trim());
    if (match === null) {
      throw invalid(
        '"confirm_token" não tem o formato de um token do forget',
        'Chame forget sem confirm_token para receber um novo.',
      );
    }
    const [, expires = '', sig = ''] = match;
    if (Number.parseInt(expires, 36) * 1000 < ctx.now().getTime()) {
      throw invalid(
        'o confirm_token venceu',
        'Chame forget sem confirm_token para receber um novo e confirme logo em seguida.',
      );
    }
    const expected = Buffer.from(signature(secret, tokenFields(note, contentHash, session, expires)));
    const given = Buffer.from(sig);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw invalid(
        'o confirm_token não confere: é de outra nota, de outra sessão, foi alterado, ou a nota mudou depois do resumo',
        'Chame forget sem confirm_token para ver o resumo atual e receber um token novo.',
      );
    }
  }

  const out = await executeBatch(ctx, input.session_handle, async (config) => {
    // relida sob a trava: a nota não pode ter mudado entre a conferência do token e o arquivamento
    const current = await readNote(ctx.root, note.path);
    if (hashContent(current.text) !== contentHash) {
      throw new BrainError('conflict', `a nota ${note.path} mudou durante o forget; nada foi arquivado`, {
        nextStep: 'Chame forget de novo para ver o resumo atual.',
      });
    }
    const fields = { forget_reason: reason };
    return {
      steps: [
        {
          target: { path: current.path, diskPath: current.diskPath },
          checks: frontmatterTargets(fields, config),
          warnings: [],
          apply: () =>
            archiveNote(ctx.root, current.diskPath, {
              config,
              now: ctx.now(),
              ifUnchangedSince: current.stamp,
              ...(note.managed ? { frontmatter: fields } : {}),
            }),
        },
      ],
    };
  });
  const archived = out.results[0];
  return {
    data_notice: DATA_NOTICE,
    status: 'archived',
    note: noteOutput(note),
    summary,
    confirm_token: null,
    token_expires_at: null,
    confirmed_by: token !== undefined ? 'token' : 'user',
    op: out.op,
    commit: out.commit,
    archived_path: archived?.path ?? null,
    warnings: out.warnings,
    next_step: `Arquivada em ${archived?.path ?? 'memory/_archive/'}. Para trazer de volta: undo({ op: "${out.op}" }).`,
  };
}
