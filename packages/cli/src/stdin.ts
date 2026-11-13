import type { StdinLimits } from './types.ts';

/**
 * Lê um fluxo até o fim, com teto de bytes e de tempo. Devolve o texto (UTF-8), ou `null` quando o fluxo passa de
 * `maxBytes`, não termina em `timeoutMs` ou dá erro. Em qualquer `null` o fluxo é destruído: quem chamou segue sem a
 * entrada, e nada fica segurando o processo.
 *
 * É o que lê o JSON que o Claude Code manda para um hook. Esse JSON é entrada não confiável: o teto evita que uma
 * entrada gigante (ou um pipe que nunca fecha) prenda o hook.
 */
export function readLimited(stream: NodeJS.ReadableStream, limits: StdinLimits): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      if (value === null) (stream as Partial<{ destroy: () => void }>).destroy?.();
      else stream.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > limits.maxBytes) {
        finish(null);
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => finish(Buffer.concat(chunks).toString('utf8'));
    const onError = (): void => finish(null);
    const timer = setTimeout(() => finish(null), limits.timeoutMs);
    timer.unref?.();
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.resume();
  });
}
