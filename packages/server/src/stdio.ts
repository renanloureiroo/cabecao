// Entrada stdio: `cabecao mcp` chama `runStdioServer`. O stdout é só do protocolo (JSON-RPC, uma mensagem por
// linha); todo diagnóstico vai para o stderr.

import type { Readable, Writable } from 'node:stream';
import { format } from 'node:util';
import type { EmbeddingProvider } from '@cabecao/core';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import { createBrainProvider } from './brains.ts';
import { LineLimiter, MAX_MESSAGE_BYTES } from './line-limit.ts';
import { buildServer } from './server.ts';
import type { ServerRuntime, SyncRunner } from './tools.ts';

export interface StdioServerOptions {
  /** Pasta do cérebro. */
  brainRoot: string;
  /** Versão do pacote `cabecao`. */
  version: string;
  /** Nome da máquina nos rodapés dos commits. Padrão: o da configuração da máquina, senão o hostname. */
  machine?: string;
  /** Quando presente, a tool `sync` usa isto (a CLI roda o sync em processo separado); senão, roda no próprio processo. */
  syncRunner?: SyncRunner;
  /** Runtime de embeddings (a CLI injeta). O modelo carrega na primeira busca que precisa dele, nunca na subida. */
  embeddings?: EmbeddingProvider;
  /** Limite de uma mensagem JSON-RPC, em bytes. Padrão: `MAX_MESSAGE_BYTES` (10 MiB). Para testes. */
  maxMessageBytes?: number;
  /** Para testes. Sem eles, usa o stdin e o stdout do processo e cuida dos sinais. */
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

/** Código JSON-RPC de "Invalid Request". */
const INVALID_REQUEST = -32600;

const mib = (bytes: number): string =>
  `${(bytes / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MiB`;

/** Quanto o processo espera, depois de fechar tudo num SIGTERM/SIGINT, antes de sair à força. */
const EXIT_GRACE_MS = 2000;

const SIGNAL_EXIT_CODES: Readonly<Record<string, number>> = { SIGINT: 130, SIGTERM: 143 };

function stderrLog(message: string): void {
  try {
    process.stderr.write(`[cabecao] ${message}\n`);
  } catch {
    // stderr fechado: não há onde relatar
  }
}

/**
 * Manda `console.log`/`info`/`debug` para o stderr enquanto o servidor roda, para nenhum `console.log` perdido
 * (nosso ou de dependência) corromper o canal JSON-RPC. Devolve a função que desfaz.
 */
function guardStdout(): () => void {
  const original = { log: console.log, info: console.info, debug: console.debug };
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(`${format(...args)}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  return () => {
    console.log = original.log;
    console.info = original.info;
    console.debug = original.debug;
  };
}

/**
 * Serve MCP por stdio, nas duas gerações do protocolo (2026-07-28 e 2025-11-25). Subir não abre o cérebro nem toca
 * em arquivo: ele abre na primeira chamada de tool. Resolve quando o transporte fecha (o cliente fechou o stdin, o
 * stdout quebrou ou chegou SIGTERM/SIGINT), depois de esperar as operações em andamento e fechar o banco.
 *
 * Com o stdio do processo (sem `stdin`/`stdout` nas opções), também: desvia `console.log` para o stderr, relata no
 * stderr promessas rejeitadas sem tratamento (em vez de derrubar o processo) e, num sinal, fecha tudo e encerra o
 * processo com o código do sinal.
 */
export function runStdioServer(options: StdioServerOptions): Promise<void> {
  const ownsProcess = options.stdin === undefined && options.stdout === undefined;
  const runtime: ServerRuntime = {
    version: options.version,
    brains: createBrainProvider({
      root: options.brainRoot,
      ...(options.machine === undefined ? {} : { machine: options.machine }),
      ...(options.embeddings === undefined ? {} : { embeddings: options.embeddings }),
    }),
    ...(options.syncRunner === undefined ? {} : { syncRunner: options.syncRunner }),
    log: stderrLog,
  };
  // Mensagem grande demais: o transporte do SDK fecharia a conexão em silêncio (e o processo sairia com 0). O
  // filtro descarta só aquela mensagem, avisa no stderr e responde ao pedido com um erro claro.
  const source = (options.stdin ?? process.stdin) as Readable;
  const maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
  const limiter = new LineLimiter({
    maxBytes: maxMessageBytes,
    onOversize: ({ id, bytes, maxBytes }) => {
      stderrLog(
        `mensagem de ${mib(bytes)} recusada: o limite é ${mib(maxBytes)} por mensagem${id === undefined ? ' (sem id: nada a responder)' : ` (pedido ${JSON.stringify(id)})`}`,
      );
      if (id === undefined) return;
      transport
        .send({
          jsonrpc: '2.0',
          id,
          error: {
            code: INVALID_REQUEST,
            message: `mensagem grande demais (${mib(bytes)}): o limite é ${mib(maxBytes)} por mensagem; o corpo de uma nota vai até 1.000.000 caracteres. Divida o conteúdo em notas menores.`,
          },
        })
        .catch((error: unknown) => stderrLog(`ao responder à mensagem grande demais: ${String(error)}`));
    },
  });
  source.on('error', (error) => limiter.destroy(error));
  source.pipe(limiter);
  // o filtro já garante o limite; o do transporte fica acima dele, só como rede de segurança
  const transport = new StdioServerTransport(limiter as Readable, (options.stdout ?? process.stdout) as Writable, {
    maxBufferSize: maxMessageBytes * 2,
  });

  return new Promise<void>((resolve) => {
    const restoreConsole = ownsProcess ? guardStdout() : () => undefined;
    const onRejection = (reason: unknown): void => {
      stderrLog(
        `promessa rejeitada sem tratamento: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
      );
    };
    let finishing: Promise<void> | null = null;
    const finish = (): Promise<void> => {
      finishing ??= (async () => {
        process.off('SIGTERM', onSignal);
        process.off('SIGINT', onSignal);
        await handle.close().catch((error: unknown) => stderrLog(`ao fechar o transporte: ${String(error)}`));
        // solta o stdin: o filtro não lê mais nada, e o stdin não pode segurar o processo aberto
        source.unpipe(limiter);
        source.pause();
        await runtime.brains.close().catch((error: unknown) => stderrLog(`ao fechar o cérebro: ${String(error)}`));
        restoreConsole();
        process.off('unhandledRejection', onRejection);
        resolve();
      })();
      return finishing;
    };
    const onSignal = (signal: NodeJS.Signals): void => {
      // antes de resolver: quem espera `runStdioServer` já encontra o código do sinal
      process.exitCode = SIGNAL_EXIT_CODES[signal] ?? 1;
      // um segundo sinal durante o encerramento cai no comportamento padrão (`finish` tira estes ouvintes)
      void finish().then(() => {
        // o loop deveria esvaziar sozinho; se algo o segurar, sai mesmo assim
        setTimeout(() => process.exit(), EXIT_GRACE_MS).unref();
      });
    };

    const handle = serveStdio(() => buildServer(runtime), {
      transport,
      legacy: 'serve',
      onerror: (error) => stderrLog(`protocolo: ${error.message}`),
    });
    // `serveStdio` já instalou o seu `onclose`; o nosso roda depois dele
    const onClose = transport.onclose;
    transport.onclose = () => {
      onClose?.();
      void finish();
    };
    if (ownsProcess) {
      process.on('SIGTERM', onSignal);
      process.on('SIGINT', onSignal);
      process.on('unhandledRejection', onRejection);
    }
  });
}
