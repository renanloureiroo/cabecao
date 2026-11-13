import type { Brain, EmbeddingConfig, EmbeddingsStatusOutput, EmbedProgress } from '@cabecao/core';
import { readBrainConfig, setLocalEmbeddingsDisabled } from '@cabecao/core';
import {
  CATALOG_MODEL_NAMES,
  type CatalogModel,
  catalogConfig,
  EmbeddingsError,
  findCatalogModel,
  type InstallProgress,
  MODEL_CATALOG,
  modelCacheStatus,
  runtimeStatus,
} from '@cabecao/embeddings';
import { resolveBrain, toCliError, withBrain } from '../brain.ts';
import {
  embeddingsCacheDir,
  ensureModel,
  ensureRuntime,
  FAKE_EMBEDDER_ENV,
  fakeEmbedderOn,
  pinRevision,
  specOf,
} from '../embeddings.ts';
import { CliError, UsageError } from '../errors.ts';
import { formatBytes } from '../text.ts';
import type { CommandContext, CommandResult } from '../types.ts';

const SUBCOMMANDS = ['on', 'off', 'status', 'switch'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const pct = (value: number): string => `${Math.round(value)}%`;
const mrr = (value: number): string => value.toFixed(3).replace('.', ',');

/** Tamanho do download de um modelo do catálogo (ONNX da variante padrão mais o tokenizador). */
function downloadMb(model: CatalogModel): number {
  const variant = model.variants[model.defaultVariant];
  return Math.round((variant?.onnxMB ?? 0) + model.tokenizerMB);
}

/** A tabela de sugestões do doc 06, com tamanho, qualidade e licença. */
export function catalogTable(): string {
  const lines = ['Modelos sugeridos (medidos em português; doc 06, "Sugestões testadas"):', ''];
  MODEL_CATALOG.forEach((model, i) => {
    const variant = model.variants[model.defaultVariant];
    lines.push(
      `  ${i + 1}. ${model.name}  ${downloadMb(model)} MB · acerto ${mrr(variant?.syntheticMrr ?? 0)} · paráfrases ${pct(variant?.paraphraseR1 ?? 0)} · ${model.license}`,
    );
    lines.push(`     ${model.indicatedFor}${model.licenseNote ? ` (licença: ${model.licenseNote})` : ''}`);
  });
  lines.push('', 'Fora da lista, qualquer modelo ONNX do Hugging Face pode ser declarado no .cabecao.json (doc 06).');
  return lines.join('\n');
}

function progressWriter(ctx: CommandContext): (event: EmbedProgress) => void {
  let lastEmbed = -1;
  return (event) => {
    if (event.phase === 'plan') {
      ctx.stderr.write(`Trechos: ${event.chunks}; sem vetor: ${event.missing}.\n`);
    } else if (event.phase === 'load') {
      ctx.stderr.write(`Carregando o modelo ${event.model}...\n`);
    } else if (event.phase === 'download') {
      if (event.total !== null && event.loaded === event.total) ctx.stderr.write(`Baixado: ${event.file}\n`);
    } else if (event.phase === 'embed') {
      const percent = Math.floor((event.done / Math.max(1, event.total)) * 100);
      if (percent !== lastEmbed) {
        lastEmbed = percent;
        ctx.stderr.write(`Calculando: ${event.done}/${event.total} (${percent}%)\n`);
      }
    }
  };
}

function installWriter(ctx: CommandContext): (event: InstallProgress) => void {
  return (event) => ctx.stderr.write(`Runtime (${event.backend}): ${event.message}\n`);
}

function downloadWriter(ctx: CommandContext): (event: { file: string; loaded: number; total: number | null }) => void {
  const seen = new Set<string>();
  return (event) => {
    if (!seen.has(event.file)) {
      seen.add(event.file);
      ctx.stderr.write(`Baixando ${event.file}${event.total === null ? '' : ` (${formatBytes(event.total)})`}...\n`);
    }
  };
}

async function ask(ctx: CommandContext, question: string): Promise<string | null> {
  return ctx.prompt === undefined ? null : ctx.prompt(question);
}

/** Escolhe o modelo: o pedido, ou pergunta mostrando as sugestões; sem terminal, explica como passar o nome. */
async function chooseModel(ctx: CommandContext, requested: string | undefined): Promise<CatalogModel> {
  if (requested !== undefined) {
    const model = findCatalogModel(requested);
    if (model === undefined) {
      throw new CliError(`modelo desconhecido: "${requested}"`, {
        code: 'unknown_model',
        hint: `Sugestões: ${CATALOG_MODEL_NAMES.join(', ')}. Um modelo próprio é declarado à mão no .cabecao.json (doc 06).`,
      });
    }
    return model;
  }
  if (ctx.prompt === undefined) {
    throw new CliError('diga qual modelo usar: não há terminal para perguntar', {
      code: 'model_required',
      hint: `${catalogTable()}\n\nRode "cabecao embeddings on <modelo>", por exemplo "cabecao embeddings on multilingual-e5-small".`,
    });
  }
  ctx.stderr.write(`${catalogTable()}\n\n`);
  for (let tries = 0; tries < 3; tries++) {
    const answer = (await ask(ctx, `Qual modelo? (1-${MODEL_CATALOG.length} ou o nome): `))?.trim() ?? null;
    if (answer === null || answer === '') break;
    const byNumber = /^\d+$/.test(answer) ? MODEL_CATALOG[Number(answer) - 1] : undefined;
    const model = byNumber ?? findCatalogModel(answer);
    if (model !== undefined) return model;
    ctx.stderr.write(`Não reconheci "${answer}".\n`);
  }
  throw new CliError('nenhum modelo escolhido; nada foi alterado', { code: 'model_required' });
}

/** Licença que não é de código aberto reconhecida: confirma antes (ou exige `--yes` sem terminal). */
async function confirmLicense(ctx: CommandContext, model: CatalogModel): Promise<void> {
  if (model.licenseNote === undefined || ctx.values.yes === true) return;
  const warning = `A licença do ${model.name} é "${model.license}": ${model.licenseNote}.`;
  if (ctx.prompt === undefined) {
    throw new CliError(warning, {
      code: 'license_confirmation',
      hint: `Leia os termos e rode de novo com --yes para aceitar, ou escolha um modelo de licença aberta (${MODEL_CATALOG.filter(
        (m) => m.licenseNote === undefined,
      )
        .map((m) => m.name)
        .join(', ')}).`,
    });
  }
  const answer = await ask(ctx, `${warning}\nContinuar com ele? [s/N] `);
  if (!/^s(im)?$/i.test(answer?.trim() ?? ''))
    throw new CliError('cancelado; nada foi alterado', { code: 'cancelled' });
}

function stringOption(ctx: CommandContext, name: string): string | undefined {
  const value = ctx.values[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Erros do runtime (`EmbeddingsError`, com `code`) viram mensagens da CLI com o código do runtime. */
function runtimeError(error: unknown): unknown {
  if (error instanceof EmbeddingsError) return new CliError(error.message, { code: error.code, cause: error });
  return toCliError(error);
}

function fakeWarning(ctx: CommandContext): void {
  if (fakeEmbedderOn(ctx)) {
    ctx.stderr.write(
      `Aviso: ${FAKE_EMBEDDER_ENV}=1: embedder FALSO de teste (sem runtime, sem download; vetores numa pasta própria).\n`,
    );
  }
}

interface OnData {
  readonly model: string;
  readonly variant: string;
  readonly revision: string | null;
  readonly chosen_now: boolean;
  readonly commit: string | null;
  readonly runtime: { readonly backend: string | null; readonly already_installed: boolean | null };
  readonly computed: number;
  readonly pending: number;
  readonly chunks: number;
  readonly ms: number;
}

async function turnOn(ctx: CommandContext, root: string): Promise<CommandResult> {
  const requested = stringOption(ctx, 'model') ?? ctx.positionals[1];
  if (ctx.positionals.length > 2) throw new UsageError(`argumento a mais: ${ctx.positionals.slice(2).join(' ')}`);
  const started = performance.now();
  fakeWarning(ctx);
  return withBrain(ctx, root, async (brain) => {
    const config = await readBrainConfig(root);
    let embedding: EmbeddingConfig;
    let chosenNow = false;
    if (config.embedding !== undefined) {
      if (requested !== undefined && requested !== config.embedding.model) {
        throw new CliError(`este cérebro já usa ${config.embedding.model}`, {
          code: 'model_already_chosen',
          hint: `Para trocar de modelo, rode "cabecao embeddings switch ${requested}".`,
        });
      }
      embedding = config.embedding;
      ctx.stderr.write(`O cérebro já usa ${embedding.model}: esta máquina passa a usar o mesmo modelo.\n`);
    } else {
      const model = await chooseModel(ctx, requested);
      await confirmLicense(ctx, model);
      embedding = { ...catalogConfig(model.name, stringOption(ctx, 'variant')) };
      chosenNow = true;
    }
    let runtime: OnData['runtime'] = { backend: fakeEmbedderOn(ctx) ? 'fake' : null, already_installed: null };
    try {
      specOf(embedding);
      const installed = await ensureRuntime(ctx, installWriter(ctx));
      if (installed !== null)
        runtime = { backend: installed.backend ?? null, already_installed: installed.alreadyInstalled };
      if (chosenNow) {
        const revision = await pinRevision(ctx, embedding);
        if (revision !== undefined) embedding = { ...embedding, revision };
      }
      await ensureModel(ctx, embedding, downloadWriter(ctx));
    } catch (error) {
      throw runtimeError(error);
    }
    let commit: string | null = null;
    // a escolha só é gravada depois de o runtime e o modelo funcionarem nesta máquina
    if (chosenNow) commit = (await brain.setEmbedding(embedding)).commit;
    await setLocalEmbeddingsDisabled(root, false);
    const computed = await brain.computeEmbeddings({ onProgress: progressWriter(ctx) });
    const data: OnData = {
      model: embedding.model,
      variant: embedding.variant,
      revision: typeof embedding.revision === 'string' ? embedding.revision : null,
      chosen_now: chosenNow,
      commit,
      runtime,
      computed: computed.computed,
      pending: computed.pending,
      chunks: computed.chunks,
      ms: Math.round(performance.now() - started),
    };
    const lines = [
      `Busca por significado ligada com ${data.model} (${data.variant}${data.revision === null ? '' : `, revisão ${data.revision.slice(0, 12)}`}).`,
      chosenNow
        ? `A escolha foi gravada no .cabecao.json (commit ${commit?.slice(0, 12) ?? '?'}); as outras máquinas usam o mesmo modelo.`
        : 'Modelo já escolhido no cérebro: nada mudou no .cabecao.json.',
      `Embeddings: ${data.computed} calculados agora, ${data.chunks - data.pending - data.computed} já existiam${data.pending > 0 ? `, ${data.pending} pendentes` : ''}.`,
      'Rode "cabecao sync" para enviar a escolha e os vetores às outras máquinas.',
    ];
    return { data, text: lines.join('\n') };
  });
}

async function turnOff(ctx: CommandContext, root: string): Promise<CommandResult> {
  if (ctx.positionals.length > 1) throw new UsageError(`argumento a mais: ${ctx.positionals.slice(1).join(' ')}`);
  let config: Awaited<ReturnType<typeof readBrainConfig>>;
  try {
    config = await readBrainConfig(root);
  } catch (error) {
    throw toCliError(error);
  }
  await setLocalEmbeddingsDisabled(root, true);
  const data = { disabled_here: true, model: config.embedding?.model ?? null };
  return {
    data,
    text: [
      'Busca por significado desligada NESTA máquina.',
      'Nada mudou no cérebro: o modelo continua no .cabecao.json e os vetores continuam na branch de índice, para as',
      'outras máquinas. Aqui, a busca usa só a palavra-chave e o sync não calcula vetores (mas continua levando e',
      'trazendo os que as outras máquinas calcularam). "cabecao embeddings on" religa.',
    ].join('\n'),
  };
}

export function statusLines(status: EmbeddingsStatusOutput): string[] {
  if (!status.configured) {
    return ['Busca por significado: desativada neste cérebro ("cabecao embeddings on" ativa).'];
  }
  const lines = [
    `Modelo: ${status.model} (${status.variant}, ${status.dims} dimensões, receita ${status.recipe}${
      status.revision === null ? ', arquivos de main' : `, revisão ${status.revision.slice(0, 12)}`
    })`,
    `Nesta máquina: ${status.enabled_here ? 'ligada' : 'desligada ("cabecao embeddings on" religa)'} · runtime: ${status.runtime}${
      status.runtime_detail === null ? '' : ` (${status.runtime_detail})`
    }`,
    `Trechos: ${status.chunks} · com vetor: ${status.with_vector ?? '?'} · sem vetor (na fila): ${status.pending ?? '?'}`,
    `Branch de índice: geração ${status.generation ?? '—'} · vetores do modelo: ${status.vectors ?? '?'}`,
  ];
  if (status.problem !== null) lines.push(`Problema: ${status.problem}`);
  return lines;
}

async function showStatus(ctx: CommandContext, root: string): Promise<CommandResult> {
  if (ctx.positionals.length > 1) throw new UsageError(`argumento a mais: ${ctx.positionals.slice(1).join(' ')}`);
  return withBrain(ctx, root, async (brain: Brain) => {
    const status = await brain.embeddingsStatus();
    const size = await brain.indexSize().catch(() => null);
    const cache = embeddingsCacheDir(ctx);
    const fake = fakeEmbedderOn(ctx);
    const runtime = fake ? null : await runtimeStatus({ cacheDir: cache }).catch(() => null);
    let model: { cached: boolean; dir: string; missing: string[] } | null = null;
    if (!fake && status.configured) {
      const config = await readBrainConfig(root);
      if (config.embedding !== undefined) {
        try {
          model = await modelCacheStatus(specOf(config.embedding), { cacheDir: cache });
        } catch {
          model = null;
        }
      }
    }
    const data = {
      ...status,
      index_bytes: size?.bytes ?? null,
      runtime_install:
        runtime === null ? null : { installed: runtime.installed, backend: runtime.backend ?? null, dir: runtime.dir },
      model_cache: model,
      fake,
    };
    const lines = statusLines(status);
    if (size !== null) lines.push(`Tamanho da branch de índice (geração corrente): ${formatBytes(size.bytes)}`);
    if (runtime !== null) {
      lines.push(
        `Runtime: ${runtime.installed ? `instalado (${runtime.backend ?? '?'}) em ${runtime.dir}` : `não instalado (${runtime.dir})`}`,
      );
    }
    if (model !== null)
      lines.push(
        `Modelo no cache: ${model.cached ? `sim (${model.dir})` : `não (faltam ${model.missing.join(', ')})`}`,
      );
    if (fake) lines.push(`Embedder FALSO de teste (${FAKE_EMBEDDER_ENV}=1).`);
    return { data, text: lines.join('\n') };
  });
}

async function switchModel(ctx: CommandContext, root: string): Promise<CommandResult> {
  const requested = stringOption(ctx, 'model') ?? ctx.positionals[1];
  if (requested === undefined) throw new UsageError('diga para qual modelo trocar: cabecao embeddings switch <modelo>');
  if (ctx.positionals.length > 2) throw new UsageError(`argumento a mais: ${ctx.positionals.slice(2).join(' ')}`);
  fakeWarning(ctx);
  return withBrain(ctx, root, async (brain) => {
    const config = await readBrainConfig(root);
    if (config.embedding === undefined) {
      throw new CliError('a busca por significado ainda não está ativada neste cérebro', {
        code: 'embeddings_unavailable',
        hint: `Rode "cabecao embeddings on ${requested}".`,
      });
    }
    const model = await chooseModel(ctx, requested);
    await confirmLicense(ctx, model);
    let next: EmbeddingConfig = { ...catalogConfig(model.name, stringOption(ctx, 'variant')) };
    try {
      await ensureRuntime(ctx, installWriter(ctx));
      const revision = await pinRevision(ctx, next);
      if (revision !== undefined) next = { ...next, revision };
      await ensureModel(ctx, next, downloadWriter(ctx));
    } catch (error) {
      throw runtimeError(error);
    }
    await setLocalEmbeddingsDisabled(root, false);
    const result = await brain.switchEmbeddings(next, { onProgress: progressWriter(ctx) });
    const text = result.switched
      ? [
          `Troca concluída: ${result.from} → ${result.to} (${result.computed} vetores calculados).`,
          `O .cabecao.json passou a usar ${model.name} (commit ${result.commit?.slice(0, 12) ?? '?'}). A pasta antiga sai no próximo "cabecao compact".`,
          'Rode "cabecao sync" para enviar a troca e os vetores às outras máquinas.',
        ]
      : [
          `Troca interrompida: ${result.pending} trechos ainda sem vetor do modelo novo. A busca continua com ${result.from}.`,
          `Rode "cabecao embeddings switch ${model.name}" de novo para continuar de onde parou.`,
        ];
    return { code: result.switched ? 0 : 1, data: result, text: text.join('\n') };
  });
}

export async function run(ctx: CommandContext): Promise<CommandResult> {
  const sub = ctx.positionals[0] ?? 'status';
  if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new UsageError(`subcomando desconhecido: "${sub}" (use ${SUBCOMMANDS.join(', ')})`);
  }
  const root = await resolveBrain(ctx);
  switch (sub as Subcommand) {
    case 'on':
      return turnOn(ctx, root);
    case 'off':
      return turnOff(ctx, root);
    case 'switch':
      return switchModel(ctx, root);
    default:
      return showStatus(ctx, root);
  }
}
