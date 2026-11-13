import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { IngestInput, IngestOutput } from '@cabecao/core';
import { INGEST_MAX_BYTES, splitFrontmatter } from '@cabecao/core';
import { resolveBrain, withBrain } from '../brain.ts';
import { CliError, UsageError } from '../errors.ts';
import type { CommandContext, CommandResult } from '../types.ts';

export function ingestText(output: IngestOutput): string {
  const lines = [
    output.source.registered
      ? `Fonte registrada em ${output.source.path} (trust: low, ${output.source.chars.toLocaleString('pt-BR')} caracteres).`
      : `A fonte já estava em ${output.source.path}; nada foi gravado.`,
  ];
  if (output.commit !== null) lines.push(`Commit ${output.commit.slice(0, 10)} (operação ${output.op}).`);
  for (const warning of output.warnings) lines.push(`Aviso: ${warning.message}`);
  lines.push('', 'Plano de ingestão (para o agente executar):');
  output.plan.steps.forEach((step, i) => {
    lines.push(`  ${i + 1}. ${step}`);
  });
  if (output.plan.update.length > 0) {
    lines.push('', 'Notas que a fonte cita ou de que trata:');
    for (const note of output.plan.update) {
      lines.push(
        `  - ${note.title ?? note.path} (${note.path}) · ${note.reason === 'mention' ? 'citada' : 'parecida'}`,
      );
    }
  }
  lines.push('', 'Peça a um agente com o Cabeção para executar o plano (o prompt "ingest" do servidor MCP faz isso).');
  return lines.join('\n');
}

/** Um título a partir do nome do arquivo: sem a extensão, hífens e sublinhados viram espaço. */
const titleFromFile = (file: string): string => basename(file, extname(file)).replace(/[-_]+/g, ' ').trim();

export async function run(ctx: CommandContext): Promise<CommandResult> {
  const [file, ...rest] = ctx.positionals;
  if (file === undefined) throw new UsageError('informe o arquivo: cabecao ingest <arquivo>');
  if (rest.length > 0) throw new UsageError(`argumento a mais: ${rest.join(' ')}`);
  const title = typeof ctx.values.title === 'string' ? ctx.values.title : undefined;
  const scope = typeof ctx.values.scope === 'string' ? ctx.values.scope : undefined;
  const root = await resolveBrain(ctx);
  const absolute = resolve(ctx.cwd, file);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(absolute);
  } catch {
    throw new CliError(`arquivo não encontrado: ${absolute}`, { code: 'ENOENT' });
  }
  if (!info.isFile()) throw new CliError(`${absolute} não é um arquivo`, { code: 'EISDIR' });
  if (info.size > INGEST_MAX_BYTES) {
    throw new CliError(`${absolute} tem ${info.size} bytes; o limite do ingest é ${INGEST_MAX_BYTES}`, {
      code: 'EFBIG',
    });
  }

  // um arquivo de dentro do cérebro vai pelo caminho (uma fonte que já está em raw/ não é copiada de novo);
  // um de fora, o usuário indicou aqui: a CLI lê e manda o texto
  const realRoot = await realpath(root);
  const realFile = await realpath(absolute);
  const inside = relative(realRoot, realFile);
  const inBrain = inside !== '' && !inside.startsWith('..') && !isAbsolute(inside);
  let input: IngestInput;
  if (inBrain) {
    input = {
      path: inside.split(sep).join('/'),
      ...(title === undefined ? {} : { title }),
      ...(scope === undefined ? {} : { scope }),
    };
  } else {
    const data = await readFile(realFile);
    let content: string;
    try {
      if (data.includes(0)) throw new Error('nulo');
      content = new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      throw new CliError(`${absolute} não é um arquivo de texto em UTF-8; o ingest só lê Markdown e texto`, {
        code: 'EBINARY',
      });
    }
    const split = splitFrontmatter(content);
    const fromFrontmatter = typeof split.data.title === 'string' ? split.data.title.trim() : '';
    const heading = /^#{1,6}\s+(.+?)\s*$/m.exec(split.body)?.[1]?.trim() ?? '';
    input = {
      content,
      title: title ?? (fromFrontmatter || heading || titleFromFile(realFile)),
      source: basename(realFile),
      ...(scope === undefined ? {} : { scope }),
    };
  }
  const output = await withBrain(ctx, root, (brain) => brain.ingest(input, { fromUserFile: !inBrain }));
  return { data: output, text: ingestText(output) };
}
