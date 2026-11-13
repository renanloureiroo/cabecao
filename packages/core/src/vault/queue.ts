// Fila de escritas por cérebro, dentro do processo.
import { resolve } from 'node:path';

const queues = new Map<string, Promise<void>>();

/**
 * Executa `fn` depois de todas as escritas já enfileiradas para o mesmo cérebro NESTE processo terminarem.
 *
 * Por quê: a conferência do `ifUnchangedSince` e o `rename` da escrita atômica são dois passos assíncronos. Duas
 * escritas do mesmo processo (o servidor MCP atende chamadas simultâneas) podem passar juntas pela conferência, e a
 * segunda apagaria a primeira sem erro: uma linha do diário perdida, ou duas notas novas com o mesmo nome. A fila
 * fecha essa janela dentro do processo. Entre processos, quem serializa é a camada de operações, com `withLock`.
 *
 * Não é reentrante: `fn` não pode chamar outra função pública de escrita do vault.
 */
export async function serializeWrites<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(root);
  const previous = queues.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  // o executor roda na hora, então `release` já existe antes de qualquer `await`
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const tail = previous.then(() => gate);
  queues.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (queues.get(key) === tail) queues.delete(key);
  }
}
