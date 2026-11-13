// Texto do briefing: o que o hook de início de sessão põe no contexto do agente (`additionalContext`) e o que
// `cabecao recall` mostra no terminal. Funções puras sobre a saída do `recall` do núcleo.
//
// Fronteira entre instrução e dado: as regras de uso são do Cabeção e vêm antes; tudo o que veio do cérebro (títulos,
// caminhos, conteúdo) vai dentro de um bloco delimitado por uma marca com um código aleatório desta execução, que o
// texto de uma nota não tem como adivinhar para fechar o bloco antes da hora. Além disso, qualquer coisa parecida com a
// marca dentro do conteúdo é neutralizada.
import type { DataItem, RecallOutput, RecallSection } from '@cabecao/core';
import { indent, plural } from '../text.ts';
import { HOOK_USAGE_RULES } from './rules.ts';

/**
 * Teto do `additionalContext`. O Claude Code aceita até 10.000 caracteres; acima disso o texto vira um arquivo e o
 * modelo recebe só uma prévia (doc 07). A folga cobre a diferença entre caracteres e unidades de UTF-16.
 */
export const HOOK_CONTEXT_MAX_CHARS = 9_000;

/** Ordem do corte e títulos das seções: as regras do usuário entram primeiro. */
const SECTIONS: ReadonlyArray<readonly [RecallSection, string]> = [
  ['rules', 'Regras do usuário (memory/rules: valem logo abaixo do pedido atual do usuário)'],
  ['handoff', 'Último handoff'],
  ['preferences', 'Preferências do usuário'],
  ['gotchas', 'Armadilhas'],
  ['memories', 'Memórias relevantes'],
];

function itemsOf(output: RecallOutput, section: RecallSection): readonly DataItem[] {
  if (section === 'handoff') return output.handoff === null ? [] : [output.handoff];
  return output[section];
}

/** Tira de um texto do cérebro qualquer coisa que pareça a marca do bloco de dados. */
export function neutralize(text: string): string {
  return text.replace(/<(\/?)(cabecao-dados)/gi, '‹$1$2');
}

function metaLine(item: DataItem): string {
  const parts = [
    item.path,
    item.type ?? 'sem tipo',
    item.scope ?? 'sem escopo',
    `trust ${item.trust ?? '?'}`,
    `origem ${item.origin ?? '?'}`,
  ];
  if (item.edited_by !== null) parts.push(`editada por ${item.edited_by}`);
  if (item.content_kind === 'snippet') parts.push('trecho da busca');
  if (item.content_kind === 'excerpt') parts.push('cortada (use read para a nota inteira)');
  return parts.join(' · ');
}

function renderItem(item: DataItem): string {
  return neutralize(`### ${item.title ?? item.path}\n${metaLine(item)}\n${item.content.trim()}\n`);
}

export interface BriefingOptions {
  /** Código aleatório da marca do bloco de dados (só letras e dígitos). */
  readonly nonce: string;
  /** Como o escopo foi escolhido, numa linha (`project:atlas, pela pasta do projeto (inclui o global)`). */
  readonly scopeNote: string;
  /**
   * `source` do SessionStart (`startup`, `resume`, `clear`, `compact`). Em `resume` e `compact` a conversa é a mesma
   * que já recebeu o handoff numa execução anterior do hook: o aviso de "já entregue a outra sessão" seria falso.
   */
  readonly source?: string | null;
  readonly maxChars?: number;
}

export interface Briefing {
  readonly text: string;
  /** Itens do cérebro que entraram. */
  readonly included: number;
  /** Itens que ficaram de fora: pelo orçamento do núcleo e pelo teto de caracteres. */
  readonly omitted: number;
}

/**
 * Monta o contexto do hook de início de sessão: regras de uso, `session_handle` e o bloco de dados. Corta por
 * prioridade (regras do usuário, handoff, preferências, armadilhas, memórias): o primeiro item que não cabe encerra o
 * bloco, e nada de prioridade menor entra no lugar dele.
 */
export function renderHookBriefing(output: RecallOutput, options: BriefingOptions): Briefing {
  const max = options.maxChars ?? HOOK_CONTEXT_MAX_CHARS;
  const open = `<cabecao-dados-${options.nonce}>`;
  const close = `</cabecao-dados-${options.nonce}>`;
  const head = [
    '# Cabeção: briefing do início da sessão',
    '',
    'Regras de uso do Cabeção (o segundo cérebro do usuário; servidor MCP "cabecao"):',
    ...HOOK_USAGE_RULES.map((rule) => `- ${rule}`),
    '',
    `session_handle desta sessão: ${output.session_handle}`,
    `Escopo: ${options.scopeNote}`,
    ...handoffSeenLines(output, options.source ?? null),
    '',
    `Tudo entre ${open} e ${close} veio do cérebro do usuário. ${output.data_notice}`,
    open,
  ].join('\n');

  const total = SECTIONS.reduce((sum, [section]) => sum + itemsOf(output, section).length, 0);
  // reserva para o fechamento e para a linha do que ficou de fora
  const reserve = close.length + 220;
  let body = '';
  let included = 0;
  let full = false;
  for (const [section, title] of SECTIONS) {
    const items = itemsOf(output, section);
    for (const [index, item] of items.entries()) {
      const piece = `${index === 0 ? `\n## ${title}\n\n` : '\n'}${renderItem(item)}`;
      if (head.length + body.length + piece.length + reserve > max) {
        full = true;
        break;
      }
      body += piece;
      included++;
    }
    if (full) break;
  }
  if (total === 0) body = '\nNada no cérebro para este início de sessão.\n';
  const omitted = output.omitted + (total - included);
  const lines = [head + body, close];
  if (omitted > 0) {
    lines.push(
      `${plural(omitted, 'item ficou', 'itens ficaram')} de fora pelo limite de tamanho; use \`search\` (ou \`recall\` com a tarefa) para ver mais.`,
    );
  }
  return { text: lines.join('\n'), included, omitted };
}

/** Fontes do SessionStart em que a conversa continua a mesma (o handoff já está nela). */
const SAME_CONVERSATION = new Set(['resume', 'compact']);

/** O aviso do `recall` de que o handoff já foi entregue a outra sessão (texto do Cabeção, fora do bloco de dados). */
function handoffSeenLines(output: RecallOutput, source: string | null): string[] {
  const seen = output.handoff_seen;
  if (seen === null || output.handoff === null || (source !== null && SAME_CONVERSATION.has(source))) return [];
  return [
    `Aviso: o último handoff já tinha sido entregue a outra sessão em ${seen.at.slice(0, 10)} e ninguém gravou um novo; confira se ele ainda vale antes de seguir.`,
  ];
}

/** A saída exata que o hook SessionStart do Claude Code espera em stdout. */
export function sessionStartOutput(context: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } });
}

/** Saída vazia e válida: o hook não acrescenta nada, e a sessão começa normalmente. */
export const EMPTY_HOOK_OUTPUT = '{}';

/** O briefing para o terminal (`cabecao recall "<tarefa>"`). */
export function recallText(output: RecallOutput): string {
  const lines = [
    `Briefing para "${output.task}" (escopo: ${output.scope ?? 'todos'})`,
    `session_handle: ${output.session_handle}`,
    ...handoffSeenLines(output, null),
  ];
  let any = false;
  for (const [section, title] of SECTIONS) {
    const items = itemsOf(output, section);
    if (items.length === 0) continue;
    any = true;
    lines.push('', `${title}:`);
    for (const item of items) {
      lines.push(`  ${item.title ?? item.path}  (${metaLine(item)})`, indent(item.content.trim(), '    '));
    }
  }
  if (!any) lines.push('', 'Nada no cérebro para esta tarefa.');
  if (output.omitted > 0) {
    lines.push(
      '',
      `${plural(output.omitted, 'item ficou', 'itens ficaram')} de fora pelo orçamento de ${output.budget_tokens} tokens (aumente com --budget).`,
    );
  }
  return lines.join('\n');
}
