// Fila assíncrona simples: uma execução por vez, na ordem de chegada. Só vale dentro do processo; entre processos
// quem serializa são as travas de arquivo (`withLock`).

export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  /** Executa `fn` depois de todas as execuções já enfileiradas terminarem (com sucesso ou erro). */
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.#tail.then(fn, fn);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
