// Resources (doc 05, "Resources e prompts"): o `AGENTS.md` do cérebro, o `index.md` e qualquer nota. Leitura pura;
// o cérebro só é aberto quando um resource é lido (listar não abre nada). Todo caminho passa pelo núcleo: a nota
// por `brain.read` (caminho seguro, só notas das pastas de notas) e os dois arquivos fixos por `resolveVaultPath`
// (recusa link simbólico que sai do cérebro).
import { readFile } from 'node:fs/promises';
import type { Brain } from '@cabecao/core';
import { BrainError, resolveVaultPath } from '@cabecao/core';
import type { McpServer, ReadResourceResult, ServerContext } from '@modelcontextprotocol/server';
import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
} from '@modelcontextprotocol/server';
import { toToolError } from './results.ts';
import type { ServerRuntime } from './tools.ts';
import { clientOf } from './tools.ts';

/** O arquivo de esquema do cérebro, criado pelo `cabecao init`. */
const SCHEMA_FILE = 'AGENTS.md';

export function registerResources(server: McpServer, runtime: ServerRuntime): void {
  const brainFor = (ctx: ServerContext): Promise<Brain> => runtime.brains.get(clientOf(server, ctx));

  /** Erro de leitura de resource como erro JSON-RPC (resources não têm `isError`). */
  const fail = (uri: URL, error: unknown): never => {
    if (error instanceof ProtocolError) throw error;
    const json = toToolError(error, runtime.log);
    if (json.code === 'not_found') throw new ResourceNotFoundError(uri.href, json.message);
    const message = json.next_step === undefined ? json.message : `${json.message}. ${json.next_step}`;
    const code = json.code === 'internal_error' ? ProtocolErrorCode.InternalError : ProtocolErrorCode.InvalidParams;
    throw new ProtocolError(code, message, { error: json });
  };

  const readRootFile = async (uri: URL, brain: Brain, relPath: string): Promise<ReadResourceResult> => {
    let absolute: string;
    try {
      absolute = await resolveVaultPath(brain.root, relPath);
    } catch {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `caminho recusado: ${relPath} não fica dentro do cérebro`,
      );
    }
    let text: string;
    try {
      text = await readFile(absolute, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ResourceNotFoundError(uri.href, `o cérebro não tem ${relPath}`);
      }
      throw error;
    }
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
  };

  server.registerResource(
    'schema',
    'cabecao://schema',
    {
      title: 'Brain schema (AGENTS.md)',
      description: 'How this brain is organized: note types, folders, fields and conventions.',
      mimeType: 'text/markdown',
    },
    async (uri, ctx) => {
      try {
        return await readRootFile(uri, await brainFor(ctx), SCHEMA_FILE);
      } catch (error) {
        return fail(uri, error);
      }
    },
  );

  server.registerResource(
    'index',
    'cabecao://index',
    {
      title: 'Brain catalog (index.md)',
      description: 'Catalog of every note, grouped by folder.',
      mimeType: 'text/markdown',
    },
    async (uri, ctx) => {
      try {
        const brain = await brainFor(ctx);
        return await readRootFile(uri, brain, brain.config.indexMd);
      } catch (error) {
        return fail(uri, error);
      }
    },
  );

  server.registerResource(
    'page',
    // `{+path}`: o caminho tem `/` (spike 10, P6)
    new ResourceTemplate('cabecao://page/{+path}', { list: undefined }),
    {
      title: 'Note',
      description: 'One note as JSON, the same as the read tool: content, frontmatter, links and backlinks.',
      mimeType: 'application/json',
    },
    async (uri, variables, ctx) => {
      try {
        const raw = Array.isArray(variables.path) ? variables.path.join('/') : String(variables.path ?? '');
        let path: string;
        try {
          path = decodeURIComponent(raw);
        } catch {
          throw new BrainError('invalid_argument', `caminho mal codificado na URI: ${raw}`);
        }
        const output = await (await brainFor(ctx)).read({ path });
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(output) }] };
      } catch (error) {
        return fail(uri, error);
      }
    },
  );
}
