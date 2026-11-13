// Estado local de uma máquina, em `.cabecao/` (fora do git, como o banco): os handoffs já entregues pelo `recall` e
// o segredo do `confirm_token`. Nada daqui vai para o remoto; perder estes arquivos não perde memória nenhuma (o
// `recall` só deixa de avisar que um handoff já foi entregue, e um `confirm_token` em aberto deixa de valer).
import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LOCAL_DIR } from '../db/index.ts';
import { FileChangedError, isUlid, writeFileAtomic } from '../util/index.ts';

const HANDOFFS_FILE = 'handoffs.json';
const SECRET_FILE = 'confirm.key';
/** Handoffs lembrados no arquivo; os mais antigos saem. */
const MAX_REMEMBERED = 200;

/** A primeira entrega de um handoff a uma sessão. */
export interface HandoffDelivery {
  readonly at: string;
  readonly session: string;
}

type Deliveries = Record<string, HandoffDelivery>;

function parseDeliveries(text: string): Deliveries {
  try {
    const value: unknown = JSON.parse(text);
    const consumed = (value as { consumed?: unknown } | null)?.consumed;
    if (typeof consumed !== 'object' || consumed === null || Array.isArray(consumed)) return {};
    const out: Deliveries = {};
    for (const [id, item] of Object.entries(consumed as Record<string, unknown>)) {
      const { at, session } = (item ?? {}) as { at?: unknown; session?: unknown };
      if (typeof at === 'string' && typeof session === 'string' && isUlid(session)) out[id] = { at, session };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Marca que o handoff `id` foi entregue à sessão `session` e devolve a entrega ANTERIOR a outra sessão, se houve
 * (`null` na primeira vez). Melhor esforço: um erro de disco não derruba o `recall`, e dois processos gravando ao
 * mesmo tempo podem perder uma marca (o pior caso é o aviso "já entregue" não aparecer).
 */
export async function markHandoffDelivered(
  root: string,
  id: string,
  session: string,
  at: Date,
): Promise<HandoffDelivery | null> {
  const dir = join(root, LOCAL_DIR);
  const file = join(dir, HANDOFFS_FILE);
  try {
    const deliveries = parseDeliveries(await readFile(file, 'utf8').catch(() => '{}'));
    const previous = deliveries[id] ?? null;
    if (previous === null) {
      deliveries[id] = { at: at.toISOString(), session };
      const kept = Object.entries(deliveries)
        .sort((a, b) => (a[1].at < b[1].at ? 1 : -1))
        .slice(0, MAX_REMEMBERED);
      await mkdir(dir, { recursive: true });
      await writeFileAtomic(file, `${JSON.stringify({ consumed: Object.fromEntries(kept) }, null, 2)}\n`);
    }
    return previous !== null && previous.session !== session ? previous : null;
  } catch {
    return null;
  }
}

/**
 * Segredo desta máquina para assinar os `confirm_token` (32 bytes aleatórios, em hexadecimal, criado na primeira
 * vez que é preciso, só com permissão do dono). Fica em `.cabecao/`, fora do git e fora do alcance das tools de
 * leitura (o caminho `.cabecao/` é recusado em toda leitura e escrita de nota).
 */
export async function confirmSecret(root: string): Promise<Buffer> {
  const dir = join(root, LOCAL_DIR);
  const file = join(dir, SECRET_FILE);
  const read = async (): Promise<Buffer | null> => {
    try {
      const text = (await readFile(file, 'utf8')).trim();
      return /^[0-9a-f]{64}$/.test(text) ? Buffer.from(text, 'hex') : null;
    } catch {
      return null;
    }
  };
  const existing = await read();
  if (existing !== null) return existing;
  await mkdir(dir, { recursive: true });
  try {
    // `ifUnchangedSince: null`: só cria; se outro processo criou no meio, vale o dele
    await writeFileAtomic(file, `${randomBytes(32).toString('hex')}\n`, { ifUnchangedSince: null, mode: 0o600 });
  } catch (error) {
    if (!(error instanceof FileChangedError)) throw error;
  }
  const created = await read();
  if (created !== null) return created;
  // um arquivo estragado (editado à mão, cortado): troca por um novo, o que só invalida os tokens em aberto
  await writeFileAtomic(file, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
  const replaced = await read();
  if (replaced === null) throw new Error(`não consegui criar o segredo local em ${file}`);
  return replaced;
}
