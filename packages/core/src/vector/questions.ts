// Conjunto de perguntas do `cabecao eval`, escrito à mão pelo usuário, em JSON Lines (UTF-8):
//
//   # Perguntas sobre o projeto Atlas. Linhas começando com # ou // e linhas em branco são ignoradas.
//   {"query": "como restauro o backup do banco?", "expected": "projects/atlas/backup.md", "kind": "paraphrase"}
//   {"id": "erro-lock", "query": "ERR_SYNC_LOCK", "expected": ["01JC3M7Q8Z5X2V9K4T6N1B0RWE"], "kind": "exact"}
//   {"query": "por que trocamos o SQS?", "expected": ["decisions/filas.md", "decisions/filas-v2.md"]}
//
// Um objeto por linha:
// - `query` (obrigatório): a pergunta, como seria feita a um agente.
// - `expected` (obrigatório): a nota certa, ou a lista das notas certas, cada uma pelo id do frontmatter ou pelo
//   caminho relativo ao cérebro (com ou sem `.md`). Cite cada nota uma vez só (id OU caminho).
// - `kind` (opcional): rótulo livre para agrupar o relatório. Sugestões, as da medição: `exact` (termo exato, ID,
//   código de erro), `paraphrase` (mesma ideia com outras palavras), `vague`, `context` (depende do título).
// - `id` (opcional): nome da pergunta no relatório; padrão `L<linha>`. Precisa ser único.
// - `note` (opcional): comentário livre, ignorado.
// Qualquer outro campo é erro (pega `expect` no lugar de `expected`). Todos os erros do arquivo saem de uma vez,
// com o número da linha.

export interface EvalQuestion {
  readonly id: string;
  readonly query: string;
  /** Ids ou caminhos das notas certas (ao menos um). */
  readonly expected: readonly string[];
  readonly kind?: string;
}

export interface EvalQuestionsIssue {
  readonly line: number;
  readonly message: string;
}

/** O arquivo de perguntas tem problemas; `issues` lista todos, com a linha. */
export class EvalQuestionsError extends Error {
  readonly code = 'EEVALQUESTIONS';
  readonly source: string;
  readonly issues: readonly EvalQuestionsIssue[];

  constructor(source: string, issues: readonly EvalQuestionsIssue[]) {
    super(
      `perguntas inválidas em ${source}:\n${issues.map((issue) => `  linha ${issue.line}: ${issue.message}`).join('\n')}`,
    );
    this.name = 'EvalQuestionsError';
    this.source = source;
    this.issues = issues;
  }
}

const FIELDS = new Set(['id', 'query', 'expected', 'kind', 'note']);

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/**
 * Lê um conjunto de perguntas em JSON Lines. `source` só aparece nas mensagens de erro.
 *
 * @throws EvalQuestionsError com todos os problemas encontrados (JSON quebrado, campo faltando, campo desconhecido,
 *   id repetido, arquivo sem nenhuma pergunta).
 */
export function parseEvalQuestions(text: string, source = 'perguntas'): EvalQuestion[] {
  const issues: EvalQuestionsIssue[] = [];
  const questions: EvalQuestion[] = [];
  const ids = new Map<string, number>();
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // BOM do Bloco de Notas
  const lines = body.split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('//')) return;
    const problem = (message: string): void => {
      issues.push({ line, message });
    };
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch (error) {
      problem(`JSON inválido (${(error as Error).message})`);
      return;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      problem('esperado um objeto {"query": ..., "expected": ...}');
      return;
    }
    const record = value as Record<string, unknown>;
    const before = issues.length;
    for (const field of Object.keys(record)) {
      if (!FIELDS.has(field)) problem(`campo desconhecido "${field}" (aceitos: ${[...FIELDS].join(', ')})`);
    }
    if (!isNonEmptyString(record.query)) problem('"query" precisa ser um texto não vazio');
    const expectedRaw = typeof record.expected === 'string' ? [record.expected] : record.expected;
    let expected: string[] = [];
    if (!Array.isArray(expectedRaw) || expectedRaw.length === 0 || !expectedRaw.every(isNonEmptyString)) {
      problem('"expected" precisa ser um texto ou uma lista de textos não vazios (ids ou caminhos de notas)');
    } else {
      expected = expectedRaw.map((ref) => ref.trim());
      if (new Set(expected).size !== expected.length) problem('"expected" repete a mesma nota');
    }
    if (record.kind !== undefined && !isNonEmptyString(record.kind)) problem('"kind" precisa ser um texto não vazio');
    if (record.note !== undefined && typeof record.note !== 'string') problem('"note" precisa ser um texto');
    if (record.id !== undefined && !isNonEmptyString(record.id)) problem('"id" precisa ser um texto não vazio');
    const id = isNonEmptyString(record.id) ? record.id.trim() : `L${line}`;
    const previous = ids.get(id);
    if (previous !== undefined) problem(`id "${id}" repetido (já usado na linha ${previous})`);
    else ids.set(id, line);
    if (issues.length > before) return;
    questions.push({
      id,
      query: (record.query as string).trim(),
      expected,
      ...(isNonEmptyString(record.kind) ? { kind: record.kind.trim() } : {}),
    });
  });
  if (issues.length === 0 && questions.length === 0) issues.push({ line: 0, message: 'nenhuma pergunta no arquivo' });
  if (issues.length > 0) throw new EvalQuestionsError(source, issues);
  return questions;
}
