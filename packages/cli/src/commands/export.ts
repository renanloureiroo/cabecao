// `cabecao export canvas [--node <nota>] [--depth 1|2] [--scope <escopo>] [--limit <n>] [-o <arquivo>] [--force]`:
// um mapa do grafo em JSON Canvas (`.canvas`), que o Obsidian abre e deixa editar (doc 09, "Mapas").
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { MapGraphOutput } from '@cabecao/core';
import {
  buildCanvas,
  canvasFile,
  DEFAULT_MAP_LIMIT,
  fileStamp,
  MAX_MAP_LIMIT,
  OBSIDIAN_DASHBOARDS_DIR,
  slugify,
  validateCanvas,
  writeFileAtomic,
} from '@cabecao/core';
import { resolveBrain, withBrain } from '../brain.ts';
import { CliError, UsageError } from '../errors.ts';
import type { CommandContext, CommandResult } from '../types.ts';

function intOption(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (typeof value !== 'string' || !/^\d+$/.test(value) || n < min || n > max) {
    throw new UsageError(`--${name} deveria ser um número de ${min} a ${max}`);
  }
  return n;
}

function legend(map: MapGraphOutput): string {
  const what =
    map.center !== null
      ? `Vizinhança de [[${map.center.replace(/\.md$/i, '')}]], ${map.depth === 2 ? 'dois saltos' : 'um salto'}`
      : map.scope !== null
        ? `Notas do escopo ${map.scope}`
        : 'Notas do cérebro';
  const lines = [
    '## Mapa do Cabeção',
    `${what}: ${map.notes.length} notas e ${map.edges.length} relações.`,
    'Cada caixa junta um tipo de nota, com as cores do grafo; as setas levam o tipo da relação.',
  ];
  if (map.omitted > 0) {
    lines.push(`${map.omitted} notas ficaram de fora pelo limite de ${map.limit} (as mais longe e as menos ligadas).`);
  }
  lines.push('Gerado por "cabecao export canvas": arraste, agrupe e anote à vontade.');
  return lines.join('\n');
}

function defaultName(map: MapGraphOutput): string {
  if (map.center !== null) {
    const base = map.center.split('/').at(-1)?.replace(/\.md$/i, '') ?? 'nota';
    return `mapa-${slugify(base) || 'nota'}.canvas`;
  }
  if (map.scope !== null) return `mapa-${slugify(map.scope.replace(':', '-')) || 'escopo'}.canvas`;
  return 'mapa.canvas';
}

export async function run(ctx: CommandContext): Promise<CommandResult> {
  const [what, ...rest] = ctx.positionals;
  if (what !== 'canvas') {
    throw new UsageError(
      what === undefined ? 'falta o formato: "cabecao export canvas"' : `formato desconhecido: ${what} (só canvas)`,
    );
  }
  if (rest.length > 0) throw new UsageError(`argumento inesperado: ${rest.join(' ')}`);
  const node = typeof ctx.values.node === 'string' ? ctx.values.node : undefined;
  const scope = typeof ctx.values.scope === 'string' ? ctx.values.scope : undefined;
  const depth = intOption(ctx.values.depth, 'depth', 1, 2);
  const limit = intOption(ctx.values.limit, 'limit', 1, MAX_MAP_LIMIT);
  if (depth !== undefined && node === undefined) throw new UsageError('--depth só vale com --node');
  if (node !== undefined && scope !== undefined) throw new UsageError('use --node OU --scope, não os dois');

  const root = await resolveBrain(ctx);
  const map = await withBrain(ctx, root, (brain) =>
    brain.mapGraph({
      ...(node === undefined ? {} : { node }),
      ...(depth === undefined ? {} : { depth }),
      ...(scope === undefined ? {} : { scope }),
      ...(limit === undefined ? {} : { limit }),
    }),
  );
  if (map.notes.length === 0) {
    throw new CliError('nenhuma nota para o mapa', {
      code: 'empty_map',
      hint: scope === undefined ? 'O cérebro ainda não tem notas indexadas.' : `Nenhuma nota com scope: ${scope}.`,
    });
  }

  const canvas = buildCanvas({
    notes: map.notes,
    edges: map.edges,
    legend: legend(map),
    ...(map.center === null ? {} : { center: map.center }),
  });
  const problems = validateCanvas(canvas);
  if (problems.length > 0) throw new Error(`o mapa gerado não é um JSON Canvas válido: ${problems.join('; ')}`);

  const output =
    typeof ctx.values.output === 'string'
      ? resolve(ctx.cwd, ctx.values.output)
      : resolve(root, OBSIDIAN_DASHBOARDS_DIR, defaultName(map));
  if (!output.toLowerCase().endsWith('.canvas')) throw new UsageError('o arquivo de saída tem de terminar em .canvas');
  const inside = relative(root, output);
  const inBrain = inside !== '' && !inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside);
  if ((await fileStamp(output)) !== null && ctx.values.force !== true) {
    throw new CliError(`${output} já existe`, {
      code: 'exists',
      hint: 'Ele pode ter a sua arrumação: use -o com outro nome, ou --force para substituir.',
    });
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFileAtomic(output, canvasFile(canvas));

  const lines = [
    `Mapa: ${inBrain ? inside.split(sep).join('/') : output}`,
    `${map.notes.length} notas, ${canvas.edges.length} relações${map.omitted > 0 ? ` (${map.omitted} notas ficaram de fora pelo limite de ${map.limit}; use --limit até ${MAX_MAP_LIMIT})` : ''}.`,
  ];
  if (!inBrain) {
    lines.push('Aviso: o arquivo está fora do cérebro; o Obsidian só acha as notas de um mapa dentro do vault.');
  }
  lines.push('Abra no Obsidian; o arquivo vai para o remoto no próximo "cabecao sync".');
  return {
    data: {
      path: inBrain ? inside.split(sep).join('/') : output,
      inside_brain: inBrain,
      center: map.center,
      scope: map.scope,
      depth: map.depth,
      notes: map.notes.length,
      edges: canvas.edges.length,
      total: map.total,
      omitted: map.omitted,
      limit: map.limit ?? DEFAULT_MAP_LIMIT,
    },
    text: lines.join('\n'),
  };
}
