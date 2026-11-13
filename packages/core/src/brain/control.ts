// Arquivos de controle do cérebro (decisão 37): os que não são notas, mas mudam o comportamento de quem usa o
// cérebro. `write_page` e `patch_page` os alcançam por aqui, como texto puro (sem frontmatter de nota):
//
// - os da raiz: `AGENTS.md`, `CLAUDE.md` e os demais arquivos de instrução de cliente, `log.md`, `README.md`...;
// - um arquivo com nome de instrução de cliente de IA (`CLAUDE.md`, `GEMINI.md`...) em QUALQUER pasta;
// - `.cabecao.json`, `.gitignore` e `.gitattributes`, na raiz: só se o resultado for VÁLIDO (o `.cabecao.json` passa
//   pela validação da configuração; os outros dois continuam com as linhas que o Cabeção exige), e nunca mexendo na
//   seção `embedding` do `.cabecao.json` (ela é dos comandos de embeddings).
//
// O catálogo (`index.md`, ou o `indexMd` da configuração) é derivado e não se edita. Para um agente, toda escrita
// aqui é elevada: precisa de confirmação (`confirm.ts`). O usuário (CLI) confirma no terminal quando a CLI pede.
// Continuam valendo as proteções técnicas: caminho dentro do cérebro, nada em `.git/`/`.cabecao/` nem por link
// simbólico, o scanner de segredos (no conteúdo e no caminho) e o commit com rodapés.
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { mergeGitattributes, mergeGitignore } from '../init/merge-lines.ts';
import { REQUIRED_GITATTRIBUTES_LINES, REQUIRED_GITIGNORE_LINES } from '../init/template.ts';
import { fileStamp, isSafeRelativePath, writeFileAtomic } from '../util/index.ts';
import type { BrainConfig, WriteResult } from '../vault/index.ts';
import {
  BRAIN_CONFIG_FILE,
  diskCasePath,
  isBrainControlFile,
  isClientInstructionFile,
  isInNoteDirs,
  normalizeRelPath,
  parseBrainConfig,
  resolveVaultPath,
} from '../vault/index.ts';
import type { ConfirmOptions, Elevation } from './confirm.ts';
import { digestOf } from './confirm.ts';
import type { BrainContext } from './context.ts';
import { BrainError, toBrainError } from './errors.ts';
import type { PatchPageInput, WriteOutput, WritePageInput } from './write.ts';
import { assertAgentText, executeWrite, invalid } from './write.ts';

/** O que é o arquivo de controle: texto livre ou um dos três de configuração da raiz. */
export type ControlKind = 'text' | 'brain-config' | 'gitignore' | 'gitattributes';

const ROOT_CONFIG_FILES: Readonly<Record<string, ControlKind>> = {
  [BRAIN_CONFIG_FILE]: 'brain-config',
  '.gitignore': 'gitignore',
  '.gitattributes': 'gitattributes',
};

/**
 * Se `path` (como veio do chamador) aponta para um arquivo de controle, o caminho canônico e o tipo; senão `null`
 * (é caminho de nota, e segue o fluxo de nota). O catálogo é recusado aqui mesmo: ele é derivado.
 */
export function controlTarget(path: string, config: BrainConfig): { path: string; kind: ControlKind } | null {
  if (!isSafeRelativePath(path)) return null;
  const canonical = normalizeRelPath(path);
  const key = canonical.toLowerCase();
  const rootConfig = ROOT_CONFIG_FILES[key];
  if (rootConfig !== undefined) return { path: canonical, kind: rootConfig };
  if (key === normalizeRelPath(config.indexMd).toLowerCase()) {
    throw new BrainError(
      'invalid_path',
      `${canonical} é o catálogo do cérebro: ele é derivado das notas e refeito a cada escrita, não se edita`,
      {
        details: { path: canonical },
        nextStep: 'Altere as notas; o catálogo acompanha sozinho.',
      },
    );
  }
  if (isBrainControlFile(canonical, config) || isClientInstructionFile(canonical)) {
    if (canonical.split('/').some((segment) => segment.startsWith('.'))) return null;
    // numa subpasta de notas, o arquivo com nome de instrução é uma nota (com frontmatter), e a escrita nele é elevada
    // pelo fluxo de nota; na raiz, ou fora das pastas de notas, é texto puro
    if (canonical.includes('/') && isInNoteDirs(canonical, config)) return null;
    return { path: canonical, kind: 'text' };
  }
  return null;
}

/** Confere que o texto final de um arquivo de configuração continua válido. */
function validateControl(kind: ControlKind, path: string, text: string, before: string | null): void {
  if (kind === 'brain-config') {
    try {
      parseBrainConfig(text, path);
    } catch (error) {
      throw new BrainError('invalid_argument', `o ${path} resultante não é válido: ${(error as Error).message}`, {
        details: { path },
        nextStep: 'Mande o arquivo inteiro, em JSON válido, no formato da configuração do cérebro.',
      });
    }
    const previous = before === null ? undefined : (JSON.parse(before.replace(/^﻿/, '')) as { embedding?: unknown });
    const raw = JSON.parse(text.replace(/^﻿/, '')) as { embedding?: unknown };
    if (!isDeepStrictEqual(raw.embedding, previous?.embedding)) {
      throw new BrainError(
        'invalid_argument',
        `a seção "embedding" do ${path} não se altera por aqui: ela é dos comandos de embeddings`,
        {
          details: { path },
          nextStep: 'Mantenha "embedding" exatamente como está; o usuário troca o modelo com "cabecao embeddings".',
        },
      );
    }
    return;
  }
  if (kind === 'gitignore' || kind === 'gitattributes') {
    // só conta o que a alteração TIRA: uma linha exigida que já faltava antes não trava a edição
    const missing = (value: string): string[] => [
      ...(kind === 'gitignore'
        ? mergeGitignore(value, REQUIRED_GITIGNORE_LINES)
        : mergeGitattributes(value, REQUIRED_GITATTRIBUTES_LINES)
      ).added,
    ];
    const already = new Set(missing(before ?? ''));
    const removed = missing(text).filter((line) => !already.has(line));
    if (removed.length > 0) {
      throw new BrainError(
        'invalid_argument',
        `o ${path} resultante tira linhas que o Cabeção exige: ${removed.join(', ')}`,
        { details: { path }, nextStep: 'Mantenha essas linhas no arquivo.' },
      );
    }
  }
}

const KIND_REASON: Readonly<Record<ControlKind, string>> = {
  text: 'arquivo de controle do cérebro ou de instrução de cliente de IA: o que está nele vira instrução para os agentes',
  'brain-config': 'configuração do cérebro (.cabecao.json)',
  gitignore: 'o que o git do cérebro ignora (.gitignore)',
  gitattributes: 'como o git do cérebro trata os arquivos (.gitattributes)',
};

const preview = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= 280 ? flat : `${flat.slice(0, 280)}…`;
};

/** Escrita num arquivo de controle: o caminho de `write_page` e de `patch_page` que não é de nota. */
async function writeControlText(
  ctx: BrainContext,
  asked: { path: string; kind: ControlKind },
  tool: 'write_page' | 'patch_page',
  sessionHandle: unknown,
  token: string | undefined,
  options: ConfirmOptions,
  compute: (before: string | null) => { text: string; describe: string },
  mode: 'create' | 'overwrite' | 'append' | 'patch',
): Promise<WriteOutput> {
  let target = asked;
  return executeWrite(
    ctx,
    sessionHandle,
    async () => {
      // a grafia do disco (`claude.MD` → `CLAUDE.md`): é o nome que o git conhece
      const path = (await diskCasePath(ctx.root, target.path)).path;
      target = { path, kind: target.kind };
      const absolute = await resolveVaultPath(ctx.root, target.path, { write: true }).catch((error: unknown) => {
        throw toBrainError(error);
      });
      const stamp = await fileStamp(absolute);
      const before = stamp === null ? null : await readFile(absolute, 'utf8');
      if (mode === 'create' && before !== null) {
        throw new BrainError('already_exists', `já existe ${target.path}`, {
          details: { path: target.path },
          nextStep: 'Use mode "overwrite" ou "append".',
        });
      }
      if (mode !== 'create' && before === null) {
        throw new BrainError('not_found', `${target.path} não existe`, {
          details: { path: target.path },
          nextStep: 'Use mode "create" para criá-lo.',
        });
      }
      const { text, describe } = compute(before);
      validateControl(target.kind, target.path, text, before);
      const elevation: Elevation = {
        reasons: [KIND_REASON[target.kind]],
        summary: `${describe} ${target.path} (${KIND_REASON[target.kind]}). Conteúdo final: ${text.length.toLocaleString('pt-BR')} caracteres${before === null ? '' : `, antes ${before.length.toLocaleString('pt-BR')}`}. Começo do texto novo: "${preview(text)}"`,
        parts: [mode, target.path, digestOf(text), digestOf(before ?? '\u0000none')],
        path: target.path,
      };
      return {
        target: before === null ? null : { path: target.path, diskPath: target.path },
        checks: [
          { where: 'content', field: null, text },
          { where: 'path', field: 'path', text: target.path },
        ],
        warnings: [],
        elevation,
        apply: async (): Promise<WriteResult> => {
          const changed = before !== text;
          const after = changed ? await writeFileAtomic(absolute, text, { ifUnchangedSince: stamp }) : stamp;
          return {
            action: before === null ? 'add' : 'update',
            path: target.path,
            type: null,
            title: target.path,
            id: null,
            changed,
            stamp: after ?? { mtimeMs: 0, size: 0 },
            warnings: [],
          };
        },
      };
    },
    { tool, token, options },
  );
}

export async function writeControl(
  ctx: BrainContext,
  target: { path: string; kind: ControlKind },
  input: WritePageInput,
  token: string | undefined,
  options: ConfirmOptions,
): Promise<WriteOutput> {
  if (input.frontmatter !== undefined) {
    throw invalid(
      `${target.path} não é uma nota: não tem frontmatter de nota`,
      'Mande o texto inteiro em content (com o frontmatter dentro dele, se o arquivo tiver) e sem "frontmatter".',
    );
  }
  assertAgentText(ctx, target.path, 'o caminho', 'path');
  const content = input.content;
  return writeControlText(
    ctx,
    target,
    'write_page',
    input.session_handle,
    token,
    options,
    (before) => {
      if (input.mode === 'append') {
        const base = before ?? '';
        const eol = base.includes('\r\n') ? '\r\n' : '\n';
        const sep = base === '' || base.endsWith('\n') ? '' : eol;
        return { text: `${base}${sep}${content}`, describe: 'Acrescentar ao fim de' };
      }
      return { text: content, describe: input.mode === 'create' ? 'Criar' : 'Substituir o conteúdo inteiro de' };
    },
    input.mode,
  );
}

export async function patchControl(
  ctx: BrainContext,
  target: { path: string; kind: ControlKind },
  input: PatchPageInput,
  token: string | undefined,
  options: ConfirmOptions,
): Promise<WriteOutput> {
  assertAgentText(ctx, target.path, 'o caminho', 'path');
  return writeControlText(
    ctx,
    target,
    'patch_page',
    input.session_handle,
    token,
    options,
    (before) => {
      const text = before ?? '';
      let count = 0;
      for (let at = text.indexOf(input.old); at !== -1; at = text.indexOf(input.old, at + 1)) count++;
      if (count === 0) {
        throw new BrainError('patch_not_found', `o trecho a substituir não aparece em ${target.path}`, {
          details: { path: target.path },
          nextStep: 'Leia o arquivo de novo e copie o trecho exato que quer substituir.',
        });
      }
      if (count > 1) {
        throw new BrainError('ambiguous_patch', `o trecho a substituir aparece ${count} vezes em ${target.path}`, {
          details: { path: target.path, occurrences: count },
          nextStep: 'Inclua mais contexto em old para o trecho aparecer uma vez só.',
        });
      }
      const at = text.indexOf(input.old);
      return {
        text: text.slice(0, at) + input.new + text.slice(at + input.old.length),
        describe: `Substituir um trecho (${input.old.length} → ${input.new.length} caracteres) em`,
      };
    },
    'patch',
  );
}
