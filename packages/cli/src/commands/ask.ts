// `cabecao ask "<pergunta>"`: resposta com citações conferidas, gerada pelo provedor ativado nesta máquina
// (`cabecao llm on`). Sem provedor, mostra os trechos achados e como ativar, sem erro. O código do `ask` e dos
// provedores só é carregado aqui.
import type { AskInput, AskOutput, AskResult, PreparedAsk } from '@cabecao/core';
import { AskCancelledError, activeProviderIds, BrainError, prepareAsk, sanitizeText } from '@cabecao/core';
import { resolveBrain, withBrain } from '../brain.ts';
import { CliError, UsageError } from '../errors.ts';
import { describeEntry, detectLlm, loadLlmMachine } from '../llm/machine.ts';
import { runAsk } from '../llm/run.ts';
import type { CommandContext, CommandResult } from '../types.ts';

export const ASK_EXIT = { answered: 0, not_found: 3, low_confidence: 4, unavailable: 5 } as const;

function parseLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  const limit = Number(text);
  if (!/^\d+$/.test(text) || limit < 1 || limit > 20) throw new UsageError('--limit deveria ser um número de 1 a 20');
  return limit;
}

function typesOf(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const list = (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return list.length === 0 ? undefined : list;
}

const oneLine = (text: string): string => sanitizeText(text).replace(/\s+/g, ' ').trim();

/** Caminho e seção, sem nada que o terminal interprete (vêm da nota, que pode ser de fora). */
function where(item: { path: string; heading_path: readonly string[] }): string {
  const text = item.heading_path.length === 0 ? item.path : `${item.path} › ${item.heading_path.join(' › ')}`;
  return oneLine(text);
}

function omittedLine(output: AskOutput): string | null {
  const o = output.omitted;
  const parts = [
    o.private > 0 ? `${o.private} de nota privada` : '',
    o.secret > 0 ? `${o.secret} com possível segredo` : '',
    o.policy > 0 ? `${o.policy} pela política do cérebro` : '',
    o.control > 0 ? `${o.control} de arquivo de controle` : '',
    o.budget > 0 ? `${o.budget} por falta de espaço no contexto` : '',
    o.unreadable > 0 ? `${o.unreadable} de nota com frontmatter ilegível` : '',
  ].filter((part) => part !== '');
  return parts.length === 0 ? null : `Trechos não enviados ao provedor: ${parts.join(', ')}.`;
}

function passagesBlock(output: AskOutput, max = 5): string[] {
  const passages = output.passages ?? [];
  if (passages.length === 0) return [];
  const lines = ['Trechos que achei no cérebro:'];
  for (const passage of passages.slice(0, max)) {
    const validity =
      passage.validity === 'current' ? '' : ` (${passage.validity === 'expired' ? 'vencido' : 'ainda não vigente'})`;
    lines.push(`  - ${where(passage)}${validity}`);
    const first = oneLine(passage.content).slice(0, 160);
    if (first !== '') lines.push(`    ${first}${passage.content.length > 160 ? '…' : ''}`);
  }
  if (passages.length > max) lines.push(`  (mais ${passages.length - max}; use --json para ver todos)`);
  return lines;
}

/** As linhas da resposta (as afirmações), a partir da posição `from` (as anteriores já saíram no streaming). */
function claimLines(output: AskOutput, from = 0): string[] {
  return output.claims
    .slice(from)
    .map((claim) =>
      claim.supported
        ? `${oneLine(claim.text)} ${claim.citations.map((n) => `[${n}]`).join('')}`
        : `${oneLine(claim.text)} [sem apoio]`,
    );
}

function sourcesBlock(output: AskOutput): string[] {
  if (output.citations.length === 0) return [];
  const lines = ['Fontes:'];
  for (const c of output.citations) {
    const validity = c.validity === 'current' ? 'vigente' : c.validity === 'expired' ? 'vencido' : 'ainda não vigente';
    const provenance = [
      validity,
      `trust ${c.trust ?? '?'}`,
      `origin ${c.origin ?? '?'}`,
      ...(c.edited_by === null ? [] : [`editado por ${c.edited_by}`]),
    ];
    lines.push(`  [${c.n}] ${where(c)} · ${provenance.join(' · ')}${c.related ? ' · relacionada pelo grafo' : ''}`);
    lines.push(`      "${oneLine(c.quote)}"`);
  }
  return lines;
}

async function unavailableLines(ctx: CommandContext, result: AskResult): Promise<string[]> {
  const { output, diagnostics } = result;
  const reason = output.unavailable_reason;
  const lines: string[] = [];
  if (reason === 'not_configured') {
    lines.push(
      'Nenhum provedor de respostas está ativado nesta máquina, então não há resposta gerada (nada saiu da máquina).',
    );
    const found = await detectLlm(ctx);
    if (found.claude.path !== null) {
      lines.push('Achei o Claude Code instalado. Para usá-lo nas respostas, rode "cabecao llm on" (uma confirmação).');
    } else if (found.envKeys.length > 0) {
      lines.push(
        `Achei a variável ${found.envKeys.map((k) => k.env).join(', ')}. Para usá-la nas respostas, rode "cabecao llm on".`,
      );
    } else {
      lines.push(
        'Para ativar, rode "cabecao llm on" (Anthropic, OpenAI, Gemini, OpenRouter, Groq ou um servidor local).',
      );
    }
  } else if (reason === 'disabled_for_brain') {
    lines.push(
      diagnostics.policy_problem === null
        ? 'Este cérebro não permite enviar trechos a este tipo de provedor ("llm_policy" no .cabecao.json).'
        : `O "llm_policy" do .cabecao.json está inválido, então nada foi enviado: ${diagnostics.policy_problem}.`,
    );
  } else if (reason === 'limit_reached') {
    lines.push(
      'O limite de perguntas ao provedor foi atingido (veja "limits" no llm.json), então não há resposta gerada.',
    );
  } else {
    lines.push('O provedor de respostas não respondeu, então não há resposta gerada.');
    // para um agente, nada do provedor (nome, erro, conta): só para você, no terminal
    if (ctx.actor.actor === 'human') {
      for (const attempt of diagnostics.attempts) lines.push(`  - ${attempt.provider}: ${oneLine(attempt.message)}`);
    }
    lines.push('Rode "cabecao llm test" no seu terminal para conferir o provedor.');
  }
  return lines;
}

function diagnosticsLines(result: AskResult): string[] {
  const d = result.diagnostics;
  const lines = ['', 'Diagnóstico (só para você; o agente não vê):'];
  lines.push(
    `  provedor: ${d.provider ?? 'nenhum'}${d.model === null ? '' : ` · modelo ${d.model}`}${d.destination === null ? '' : ` · destino: ${d.destination}`}`,
  );
  lines.push(`  busca: ${d.mode_used} · trechos recuperados ${d.passages_retrieved} · enviados ${d.passages_sent}`);
  lines.push(
    `  tokens: entrada ${d.usage.input_tokens ?? '?'} · saída ${d.usage.output_tokens ?? '?'}${d.cost_usd === null ? '' : ` · custo US$ ${d.cost_usd.toFixed(4).replace('.', ',')}`} · ${(d.duration_ms / 1000).toFixed(1).replace('.', ',')} s`,
  );
  for (const attempt of d.attempts)
    lines.push(`  tentativa: ${attempt.provider} · ${attempt.kind} · ${oneLine(attempt.message)}`);
  return lines;
}

async function render(ctx: CommandContext, result: AskResult, streamed: number, verbose: boolean): Promise<string> {
  const { output } = result;
  const lines: string[] = [];
  if (output.status === 'unavailable') {
    lines.push(...(await unavailableLines(ctx, result)), '', ...passagesBlock(output));
  } else if (output.status === 'not_found') {
    if (streamed > 0) lines.push('(as afirmações acima não tinham citação conferida nos trechos e foram descartadas)');
    lines.push('O cérebro não tem isso (nenhuma afirmação com citação conferida nos trechos).');
    if (output.missing !== null) lines.push(`Faltou: ${oneLine(output.missing)}`);
    if (output.removed_citations > 0) {
      lines.push(
        `${output.removed_citations} citação(ões) do provedor não conferiram com os trechos e foram descartadas.`,
      );
    }
    const block = passagesBlock(output, 3);
    if (block.length > 0) lines.push('', ...block);
  } else {
    const same = streamed > 0 && streamed <= output.claims.length;
    if (streamed > 0 && !same) lines.push('(a resposta foi refeita; a versão conferida é esta)');
    lines.push(...claimLines(output, same ? streamed : 0));
    if (output.missing !== null) lines.push('', `Faltou no cérebro: ${oneLine(output.missing)}`);
    lines.push('', ...sourcesBlock(output));
    if (output.unsupported_claims > 0) {
      lines.push(
        '',
        `${output.unsupported_claims} afirmação(ões) sem citação conferida, marcadas com [sem apoio]: confira com "cabecao search" antes de usar.`,
      );
    }
    if (output.removed_citations > 0) {
      lines.push(
        `${output.removed_citations} citação(ões) descartadas: rótulo inexistente ou texto que não está no trecho.`,
      );
    }
  }
  const omitted = omittedLine(output);
  if (omitted !== null) lines.push('', omitted);
  if (verbose) lines.push(...diagnosticsLines(result));
  return lines.join('\n').replace(/^\n+/, '');
}

async function showContext(ctx: CommandContext, root: string, input: AskInput): Promise<CommandResult> {
  const machine = await loadLlmMachine(ctx);
  const config = machine.config;
  const first = config === null ? undefined : activeProviderIds(config, machine.secret)[0];
  const entry = first === undefined ? undefined : config?.providers[first];
  // para um agente, o destino não aparece (ele não descobre provedor nem modelo)
  const destination = entry === undefined || ctx.actor.actor !== 'human' ? null : describeEntry(entry);
  const configured = entry !== undefined;
  const prepared: PreparedAsk = await withBrain(ctx, root, (brain) => prepareAsk(brain, input));
  const data = {
    destination: destination === null ? null : { provider: first, ...destination },
    as_of: prepared.asOf,
    passages_sent: prepared.outbound.passages.length,
    omitted: prepared.outbound.omitted,
    policy: { allow: prepared.policy.allow, problem: prepared.policy.problem },
    system: prepared.prompt.system,
    user: prepared.prompt.user,
  };
  const head =
    destination === null
      ? configured
        ? 'Isto é o que iria ao provedor de respostas ativado nesta máquina. Nada foi enviado.'
        : 'Nenhum provedor ativado: nada seria enviado (isto é o que iria, se houvesse). Nada foi enviado.'
      : `Seria enviado a: ${destination.destination} (modelo ${destination.model}). Nada foi enviado.`;
  const text = [
    head,
    prepared.policy.allow === 'none'
      ? `A política deste cérebro não deixa enviar (llm_policy${prepared.policy.problem === null ? '' : `: ${prepared.policy.problem}`}).`
      : '',
    omittedLine({ omitted: prepared.outbound.omitted } as AskOutput) ?? '',
    '',
    '===== mensagem de sistema =====',
    prepared.prompt.system,
    '',
    '===== mensagem do usuário =====',
    sanitizeText(prepared.prompt.user),
  ]
    .filter((line, i) => line !== '' || i > 2)
    .join('\n');
  return { data, text };
}

export async function run(ctx: CommandContext): Promise<CommandResult> {
  const question = ctx.positionals.join(' ').trim();
  if (question === '') throw new UsageError('diga a pergunta: cabecao ask "o que decidimos sobre a fila do Atlas?"');
  const limit = parseLimit(ctx.values.limit);
  const types = typesOf(ctx.values.type);
  const scope = ctx.values.scope;
  const asOf = ctx.values['as-of'];
  const input: AskInput = {
    question,
    ...(typeof scope === 'string' ? { scope } : {}),
    ...(types === undefined ? {} : { types }),
    ...(typeof asOf === 'string' ? { as_of: asOf } : {}),
    ...(limit === undefined ? {} : { limit }),
  };
  const root = await resolveBrain(ctx);
  const usage = (error: unknown): never => {
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause instanceof BrainError && cause.code === 'invalid_argument') throw new UsageError(cause.message);
    if (error instanceof BrainError && error.code === 'invalid_argument') throw new UsageError(error.message);
    throw error;
  };
  if (ctx.values['show-context'] === true) return showContext(ctx, root, input).catch(usage);

  // o diagnóstico (provedor, modelo, custo) é só para você: um agente não o recebe, nem pedindo
  const verbose = ctx.values.verbose === true && ctx.actor.actor === 'human';
  const interactive = ctx.prompt !== undefined && !ctx.json;
  const progress = (message: string): void => {
    if (interactive) ctx.stderr.write(`cabecao: ${message}\n`);
  };
  let streamed = 0;
  const numbers = new Map<string, number>();
  const interrupt = ctx.watchInterrupt?.();
  let result: AskResult;
  try {
    result = await withBrain(ctx, root, (brain) =>
      runAsk(ctx, brain, input, {
        ...(interrupt === undefined ? {} : { signal: interrupt.signal }),
        onProgress: (event) => {
          if (event.stage === 'retrieving') progress('buscando no cérebro...');
          else if (event.stage === 'generating')
            progress(event.attempt === 1 ? 'gerando a resposta...' : 'pedindo de novo no formato certo...');
        },
        ...(interactive
          ? {
              onClaim: (claim) => {
                // streaming: cada afirmação aparece assim que chega inteira e é conferida
                const nums = claim.labels.map((label) => {
                  const known = numbers.get(label);
                  if (known !== undefined) return known;
                  numbers.set(label, numbers.size + 1);
                  return numbers.size;
                });
                if (claim.index !== streamed) return;
                ctx.stdout.write(
                  `${oneLine(claim.text)} ${claim.supported ? nums.map((n) => `[${n}]`).join('') : '[sem apoio]'}\n`,
                );
                streamed++;
              },
            }
          : {}),
      }),
    ).catch(usage);
  } catch (error) {
    if (error instanceof AskCancelledError || interrupt?.signal.aborted === true) {
      throw new CliError('pergunta interrompida: o provedor foi encerrado e nada foi gravado', { code: 'ECANCELLED' });
    }
    throw error;
  } finally {
    interrupt?.dispose();
  }
  const code = ASK_EXIT[result.output.status];
  return {
    code,
    data: verbose ? { ...result.output, diagnostics: result.diagnostics } : result.output,
    text: await render(ctx, result, streamed, verbose),
  };
}
