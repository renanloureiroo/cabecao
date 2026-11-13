// Leitura de uma nota: conteúdo parseado, carimbo (data e tamanho) e hash do conteúdo.
import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import type { ParsedNote, ParseNoteOptions } from '../markdown/index.ts';
import { parseNote } from '../markdown/index.ts';
import type { FileStamp } from '../util/index.ts';
import { toPosixPath } from '../util/index.ts';
import { VaultError } from './errors.ts';
import { normalizeRelPath, resolveVaultPath } from './paths.ts';

export interface NoteRead {
  /** Caminho relativo ao cérebro, com `/` e em NFC. */
  readonly path: string;
  /** O mesmo caminho como está no disco (difere de `path` só em nome gravado em NFD). É onde uma escrita deve cair. */
  readonly diskPath: string;
  readonly note: ParsedNote;
  /** Texto completo do arquivo, como está no disco (com BOM e quebras de linha originais). */
  readonly text: string;
  /** Data de modificação e tamanho no momento da leitura; serve de `ifUnchangedSince` numa escrita posterior. */
  readonly stamp: FileStamp;
  /** SHA-256 dos bytes do arquivo, em hexadecimal. */
  readonly contentHash: string;
}

/** SHA-256 em hexadecimal; é o `content_hash` do banco local. */
export function hashContent(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

async function openForRead(absolute: string): Promise<FileHandle | null> {
  try {
    return await open(absolute, 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EISDIR: no Windows, abrir uma pasta falha já no `open` (nos outros sistemas, cai no `isFile` abaixo)
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null;
    throw error;
  }
}

/**
 * Lê e parseia uma nota. `relPath` pode vir com `/` ou `\\`, em NFC ou como está no disco (`NoteFile.diskPath`);
 * um nome gravado em NFD é achado mesmo quando o caminho chega em NFC.
 *
 * Lança `VaultError`: `unsafe_path` (caminho fora do cérebro) ou `note_not_found`. Frontmatter inválido NÃO é
 * erro aqui: vem em `note.frontmatterError`.
 */
export async function readNote(root: string, relPath: string, options: ParseNoteOptions = {}): Promise<NoteRead> {
  const absolute = await resolveVaultPath(root, relPath);
  let diskPath = toPosixPath(relPath)
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
  let handle = await openForRead(absolute);
  if (handle === null) {
    // tenta as outras formas Unicode do mesmo nome (o Linux trata NFC e NFD como arquivos diferentes)
    for (const form of ['NFC', 'NFD'] as const) {
      const other = diskPath.normalize(form);
      if (other === diskPath) continue;
      handle = await openForRead(await resolveVaultPath(root, other));
      if (handle !== null) {
        diskPath = other;
        break;
      }
    }
  }
  if (handle === null) {
    throw new VaultError('note_not_found', `nota não encontrada: ${relPath}`, { path: relPath });
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new VaultError('note_not_found', `não é um arquivo: ${relPath}`, { path: relPath });
    const bytes = await handle.readFile();
    const text = bytes.toString('utf8');
    return {
      path: normalizeRelPath(relPath),
      diskPath,
      note: parseNote(text, options),
      text,
      stamp: { mtimeMs: st.mtimeMs, size: st.size },
      contentHash: hashContent(bytes),
    };
  } finally {
    await handle.close();
  }
}
