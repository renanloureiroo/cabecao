/**
 * Padrão de commits do cérebro: assunto no estilo do Obsidian Git, uma linha por mudança
 * no corpo e rodapés que identificam operação, sessão, máquina e cliente.
 *
 * Nada aqui acrescenta linha de coautoria nem de atribuição a IA: o autor é a identidade do git do usuário.
 */

/** Modelo padrão do assunto, o mesmo do Obsidian Git. */
export const DEFAULT_SUBJECT_TEMPLATE = 'vault backup: {{date}}';
/** Formato padrão da data: o do Obsidian Git acrescido dos milissegundos. */
export const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD HH:mm:ss.SSS';
/** Quantos caracteres do identificador da sessão entram no marcador `{{session}}`. */
export const SESSION_PREFIX_LENGTH = 8;

export const COMMIT_ACTIONS = [
  'add',
  'update',
  'supersede',
  'archive',
  'ingest',
  'edit',
  'lint',
  'consolidate',
  'migrate',
  'sync',
  'conflict',
  'revert',
] as const;
export type CommitAction = (typeof COMMIT_ACTIONS)[number];

/** Uma mudança no corpo do commit; rende `add gotcha: título` ou, sem `noteType`, `edit: título`. */
export interface CommitChange {
  action: CommitAction;
  /** Tipo da nota (`gotcha`, `fact`, `decision`...). */
  noteType?: string;
  title: string;
}

export interface CommitTrailersInput {
  /** ULID da operação. */
  op: string;
  /** ULID da sessão do agente; ausente em edições manuais. */
  session?: string;
  /** Nome da máquina, definido no `init`. */
  machine: string;
  /** Quem gravou: `claude-code`, `claude-desktop`, `codex`, `cli`, `manual`. */
  client: string;
  /** Em commits de `undo`: a operação desfeita, ou várias. */
  reverts?: string | readonly string[];
  /**
   * Ação de agente confirmada pelo usuário (decisão 37): `user-token` (o agente mandou o `confirm_token`) ou `user`
   * (o usuário respondeu à pergunta do cliente).
   */
  approved?: string;
}

export interface CommitMessageInput {
  /** Modelo do assunto (`commit.message` do `.cabecao.json`). Padrão: {@link DEFAULT_SUBJECT_TEMPLATE}. */
  subjectTemplate?: string;
  /** Formato da data no estilo moment. Padrão: {@link DEFAULT_DATE_FORMAT}. */
  dateFormat?: string;
  /** Instante do commit; é formatado no fuso da máquina. */
  date: Date;
  /** Linhas do corpo: texto pronto ou mudanças estruturadas. Linhas vazias são descartadas. */
  body?: readonly (string | CommitChange)[];
  trailers: CommitTrailersInput;
  /** Valor de `{{action}}`. Padrão: a ação da primeira mudança estruturada do corpo. */
  action?: CommitAction;
  /** Valor de `{{numFiles}}`. Padrão: 0. */
  numFiles?: number;
  /** Valor de `{{hostname}}`. Padrão: `trailers.machine`. */
  hostname?: string;
}

/** Rodapés lidos de uma mensagem de commit. */
export interface CommitTrailers {
  op?: string;
  session?: string;
  machine?: string;
  client?: string;
  reverts: string[];
  /** `Cabecao-Approved`: a ação foi confirmada pelo usuário. */
  approved?: string;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DATE_TOKEN = /\[([^\]]*)\]|YYYY|YY|Q|MMMM|MMM|MM|M|Do|DD|D|dddd|ddd|HH|H|hh|h|mm|m|ss|s|SSS|SS|S|A|a|ZZ|Z|X|x/g;

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  return `${day}${['th', 'st', 'nd', 'rd'][day % 10] ?? 'th'}`;
}

function utcOffset(date: Date, separator: string): string {
  const minutes = -date.getTimezoneOffset();
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}${separator}${pad(abs % 60)}`;
}

/**
 * Formata uma data no fuso da máquina com os marcadores do moment, sem dependências.
 *
 * Aceitos: `YYYY YY Q MMMM MMM MM M Do DD D dddd ddd HH H hh h mm m ss s SSS SS S A a Z ZZ X x`, e texto literal
 * entre colchetes (`[às] HH:mm`). Nomes de mês e de dia da semana saem em inglês, como no moment sem idioma
 * configurado. Qualquer outro caractere é copiado como está.
 */
export function formatDate(date: Date, format: string = DEFAULT_DATE_FORMAT): string {
  if (Number.isNaN(date.getTime())) throw new TypeError('Data inválida.');
  const hour12 = date.getHours() % 12 || 12;
  const month = MONTHS[date.getMonth()] ?? '';
  const weekday = WEEKDAYS[date.getDay()] ?? '';
  const millis = pad(date.getMilliseconds(), 3);
  return format.replace(DATE_TOKEN, (token: string, literal: string | undefined) => {
    if (literal !== undefined) return literal;
    switch (token) {
      case 'YYYY':
        return pad(date.getFullYear(), 4);
      case 'YY':
        return pad(date.getFullYear() % 100);
      case 'Q':
        return String(Math.floor(date.getMonth() / 3) + 1);
      case 'MMMM':
        return month;
      case 'MMM':
        return month.slice(0, 3);
      case 'MM':
        return pad(date.getMonth() + 1);
      case 'M':
        return String(date.getMonth() + 1);
      case 'Do':
        return ordinal(date.getDate());
      case 'DD':
        return pad(date.getDate());
      case 'D':
        return String(date.getDate());
      case 'dddd':
        return weekday;
      case 'ddd':
        return weekday.slice(0, 3);
      case 'HH':
        return pad(date.getHours());
      case 'H':
        return String(date.getHours());
      case 'hh':
        return pad(hour12);
      case 'h':
        return String(hour12);
      case 'mm':
        return pad(date.getMinutes());
      case 'm':
        return String(date.getMinutes());
      case 'ss':
        return pad(date.getSeconds());
      case 's':
        return String(date.getSeconds());
      case 'SSS':
        return millis;
      case 'SS':
        return millis.slice(0, 2);
      case 'S':
        return millis.slice(0, 1);
      case 'A':
        return date.getHours() < 12 ? 'AM' : 'PM';
      case 'a':
        return date.getHours() < 12 ? 'am' : 'pm';
      case 'Z':
        return utcOffset(date, ':');
      case 'ZZ':
        return utcOffset(date, '');
      case 'X':
        return String(Math.floor(date.getTime() / 1000));
      case 'x':
        return String(date.getTime());
      default:
        return token;
    }
  });
}

/** Junta em uma linha só: quebras de linha viram espaço. Um título de nota nunca cria um parágrafo novo. */
function singleLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

function trailerValue(name: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new TypeError(`O rodapé ${name} não pode ter quebra de linha.`);
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(`O rodapé ${name} não pode ficar vazio.`);
  return trimmed;
}

/** Linha do corpo para uma mudança: `add gotcha: título` ou `edit: título`. */
export function formatChangeLine(change: CommitChange): string {
  const noteType = change.noteType?.trim();
  return singleLine(`${change.action}${noteType ? ` ${noteType}` : ''}: ${change.title}`);
}

/**
 * Monta a mensagem de commit completa: assunto, corpo e rodapés, separados por uma linha em branco.
 *
 * Marcadores do assunto: `{{date}}`, `{{hostname}}`, `{{numFiles}}`, `{{action}}` e `{{session}}` (os oito
 * primeiros caracteres da sessão; vazio em edições manuais). Marcadores desconhecidos ficam como estão.
 */
export function formatCommitMessage(input: CommitMessageInput): string {
  const { trailers } = input;
  const session = trailers.session === undefined ? undefined : trailerValue('Cabecao-Session', trailers.session);
  const machine = trailerValue('Cabecao-Machine', trailers.machine);
  const body = (input.body ?? [])
    .map((line) => (typeof line === 'string' ? singleLine(line) : formatChangeLine(line)))
    .filter((line) => line !== '');
  const firstChange = (input.body ?? []).find((line) => typeof line !== 'string');
  const markers: Record<string, string> = {
    date: formatDate(input.date, input.dateFormat ?? DEFAULT_DATE_FORMAT),
    hostname: input.hostname ?? machine,
    numFiles: String(input.numFiles ?? 0),
    action: input.action ?? firstChange?.action ?? '',
    session: session?.slice(0, SESSION_PREFIX_LENGTH) ?? '',
  };
  const subject = singleLine(
    (input.subjectTemplate ?? DEFAULT_SUBJECT_TEMPLATE).replace(
      /\{\{\s*(\w+)\s*\}\}/g,
      (marker: string, name: string) => markers[name] ?? marker,
    ),
  );
  if (!subject) throw new TypeError('O assunto do commit ficou vazio.');

  const reverts = trailers.reverts === undefined ? [] : [trailers.reverts].flat();
  const footer = [
    `Cabecao-Op: ${trailerValue('Cabecao-Op', trailers.op)}`,
    ...(session === undefined ? [] : [`Cabecao-Session: ${session}`]),
    `Cabecao-Machine: ${machine}`,
    `Cabecao-Client: ${trailerValue('Cabecao-Client', trailers.client)}`,
    ...reverts.map((op) => `Cabecao-Reverts: ${trailerValue('Cabecao-Reverts', op)}`),
    ...(trailers.approved === undefined
      ? []
      : [`Cabecao-Approved: ${trailerValue('Cabecao-Approved', trailers.approved)}`]),
  ];
  return `${[subject, ...(body.length > 0 ? [body.join('\n')] : []), footer.join('\n')].join('\n\n')}\n`;
}

/**
 * Lê os rodapés `Cabecao-*` de uma mensagem de commit.
 *
 * Só o último parágrafo conta, como no git: uma linha `Cabecao-Op: ...` escrita no corpo (um título de nota, por
 * exemplo) não é confundida com rodapé. O assunto sozinho também não conta.
 */
export function parseCommitTrailers(message: string): CommitTrailers {
  const trailers: CommitTrailers = { reverts: [] };
  const paragraphs = message
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n[ \t]*\n/);
  const last = paragraphs.at(-1);
  if (paragraphs.length < 2 || last === undefined) return trailers;
  for (const line of last.split('\n')) {
    const match = /^Cabecao-([A-Za-z]+):[ \t]*(.*)$/i.exec(line.trim());
    const value = match?.[2]?.trim();
    if (!match || !value) continue;
    switch (match[1]?.toLowerCase()) {
      case 'op':
        trailers.op = value;
        break;
      case 'session':
        trailers.session = value;
        break;
      case 'machine':
        trailers.machine = value;
        break;
      case 'client':
        trailers.client = value;
        break;
      case 'reverts':
        trailers.reverts.push(value);
        break;
      case 'approved':
        trailers.approved = value;
        break;
    }
  }
  return trailers;
}
