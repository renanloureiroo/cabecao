// Mesclagem segura dos três JSON do `.obsidian/` (doc 09; ADR 35: arquivo de configuração nunca se perde e só é
// alterado quando necessário). Funções puras sobre o TEXTO: devolvem o texto novo, o que foi acrescentado (para o
// registro que o `--remove` usa) e o que ficou como o usuário tinha.
//
// Regras: só acrescenta o que falta; nunca troca um valor do usuário, nunca tira nem reordena chave, grupo ou item
// dele; listas recebem os itens que faltam no fim; o resto do arquivo fica byte a byte.
import type { JsonLike, ObsidianSettings, ObsidianSettingsFile } from '@cabecao/core';
import type { JsonValue } from '../install-client/jsonc.ts';
import { deepEqual } from '../install-client/jsonc.ts';
import { addKey, appendItem, freshJson, parseObject, removeItem, removeKey, valueAt } from './json-edit.ts';

/** O que o Cabeção acrescentou a um arquivo (vai para o registro em `.cabecao/obsidian-setup.json`). */
export interface Added {
  /** O arquivo não existia: o Cabeção o criou. */
  created?: boolean;
  /** `app.json`: chaves de primeiro nível. */
  keys?: string[];
  /** `app.json`: itens acrescentados a cada lista. */
  items?: Record<string, string[]>;
  /** `graph.json`: consultas dos grupos de cor. */
  groups?: string[];
  /** `types.json`: propriedades. */
  types?: string[];
}

export interface MergeOutcome {
  /** Texto novo; igual ao de entrada quando não havia o que acrescentar. */
  readonly text: string;
  readonly added: Added;
  /** O que ficou como o usuário tinha, apesar de o Cabeção sugerir outra coisa. */
  readonly kept: readonly string[];
}

const json = (value: unknown): string => JSON.stringify(value);

function isEmpty(added: Added): boolean {
  return (
    added.created !== true &&
    (added.keys?.length ?? 0) === 0 &&
    Object.values(added.items ?? {}).every((list) => list.length === 0) &&
    (added.groups?.length ?? 0) === 0 &&
    (added.types?.length ?? 0) === 0
  );
}

export function addedNothing(added: Added): boolean {
  return isEmpty(added);
}

function mergeApp(current: string | null, want: ObsidianSettings): MergeOutcome {
  if (current === null) {
    const value: Record<string, JsonLike> = { ...want.appKeys };
    for (const [key, items] of Object.entries(want.appLists)) value[key] = [...items];
    return {
      text: freshJson(value as JsonValue),
      added: { created: true, keys: Object.keys(value) },
      kept: [],
    };
  }
  let text = current;
  const keys: string[] = [];
  const items: Record<string, string[]> = {};
  const kept: string[] = [];
  for (const [key, value] of Object.entries(want.appKeys)) {
    const existing = valueAt(text, [key]);
    if (existing === undefined) {
      text = addKey(text, [], key, value as JsonValue);
      keys.push(key);
    } else if (!deepEqual(existing, value)) {
      kept.push(`${key} = ${json(existing)} (o Cabeção sugere ${json(value)})`);
    }
  }
  for (const [key, wanted] of Object.entries(want.appLists)) {
    const existing = valueAt(text, [key]);
    if (existing === undefined) {
      text = addKey(text, [], key, [...wanted]);
      keys.push(key);
      continue;
    }
    if (!Array.isArray(existing)) {
      kept.push(`${key} = ${json(existing)} (não é uma lista; o Cabeção acrescentaria ${json(wanted)})`);
      continue;
    }
    for (const item of wanted) {
      if (!(valueAt(text, [key]) as JsonValue[]).some((have) => deepEqual(have, item))) {
        text = appendItem(text, [key], item);
        items[key] = [...(items[key] ?? []), item];
      }
    }
  }
  return { text, added: { keys, items }, kept };
}

function mergeGraph(current: string | null, want: ObsidianSettings): MergeOutcome {
  if (current === null) {
    const value = { ...want.freshGraph, colorGroups: want.colorGroups.map((group) => ({ ...group })) };
    return {
      text: freshJson(value as unknown as JsonValue),
      added: { created: true, groups: want.colorGroups.map((group) => group.query) },
      kept: [],
    };
  }
  let text = current;
  const groups: string[] = [];
  const kept: string[] = [];
  const existing = valueAt(text, ['colorGroups']);
  if (existing === undefined) {
    text = addKey(text, [], 'colorGroups', want.colorGroups.map((group) => ({ ...group })) as unknown as JsonValue);
    return { text, added: { groups: want.colorGroups.map((group) => group.query) }, kept };
  }
  if (!Array.isArray(existing)) {
    return { text, added: {}, kept: ['colorGroups não é uma lista; nenhum grupo de cor foi acrescentado'] };
  }
  for (const group of want.colorGroups) {
    const list = valueAt(text, ['colorGroups']) as JsonValue[];
    const mine = list.find(
      (item) => typeof item === 'object' && item !== null && !Array.isArray(item) && item.query === group.query,
    ) as Record<string, JsonValue> | undefined;
    if (mine === undefined) {
      text = appendItem(text, ['colorGroups'], { ...group } as unknown as JsonValue);
      groups.push(group.query);
    } else if (!deepEqual(mine.color, group.color)) {
      kept.push(`grupo de cor "${group.query}" com a cor que você escolheu`);
    }
  }
  return { text, added: { groups }, kept };
}

function mergeTypes(current: string | null, want: ObsidianSettings): MergeOutcome {
  if (current === null) {
    return {
      text: freshJson({ types: { ...want.types } }),
      added: { created: true, types: Object.keys(want.types) },
      kept: [],
    };
  }
  let text = current;
  const types: string[] = [];
  const kept: string[] = [];
  const existing = valueAt(text, ['types']);
  if (existing === undefined) {
    text = addKey(text, [], 'types', { ...want.types });
    return { text, added: { types: Object.keys(want.types) }, kept };
  }
  if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
    return { text, added: {}, kept: ['"types" não é um objeto; nenhum tipo foi acrescentado'] };
  }
  for (const [name, type] of Object.entries(want.types)) {
    const have = (valueAt(text, ['types']) as Record<string, JsonValue>)[name];
    if (have === undefined) {
      text = addKey(text, ['types'], name, type);
      types.push(name);
    } else if (have !== type) {
      kept.push(`${name} como ${json(have)} (o Cabeção sugere ${json(type)})`);
    }
  }
  return { text, added: { types }, kept };
}

/**
 * Mescla um dos três arquivos. `current` é o texto atual (`null` se não existe). Lança se o texto atual não é um
 * objeto JSON: um arquivo ilegível não é tocado.
 */
export function mergeSettingsFile(
  file: ObsidianSettingsFile,
  current: string | null,
  want: ObsidianSettings,
): MergeOutcome {
  if (current !== null) {
    const parsed = parseObject(current);
    if ('error' in parsed) throw new Error(`${file} não é JSON válido (${parsed.error}); não foi tocado`);
  }
  if (file === 'app.json') return mergeApp(current, want);
  if (file === 'graph.json') return mergeGraph(current, want);
  return mergeTypes(current, want);
}

/**
 * Tira de um arquivo o que o registro diz que o Cabeção acrescentou, MAS só o que continua com o valor que o Cabeção
 * pôs: o que o usuário mudou depois é dele e fica. Devolve o texto novo e o que ficou.
 */
export function removeAdded(
  file: ObsidianSettingsFile,
  current: string,
  added: Added,
  want: ObsidianSettings,
): { text: string; kept: string[] } {
  let text = current;
  const kept: string[] = [];
  if (file === 'app.json') {
    for (const key of added.keys ?? []) {
      const ours: JsonLike | undefined = want.appKeys[key] ?? want.appLists[key]?.slice();
      const have = valueAt(text, [key]);
      if (have === undefined) continue;
      if (ours !== undefined && deepEqual(have, ours)) text = removeKey(text, [], key);
      else kept.push(`${key} (mudou depois do setup)`);
    }
    for (const [key, items] of Object.entries(added.items ?? {})) {
      for (const item of items) {
        const list = valueAt(text, [key]);
        if (!Array.isArray(list)) continue;
        const index = list.findIndex((have) => deepEqual(have, item));
        if (index >= 0) text = removeItem(text, [key], index);
      }
    }
  } else if (file === 'graph.json') {
    for (const query of added.groups ?? []) {
      const list = valueAt(text, ['colorGroups']);
      if (!Array.isArray(list)) break;
      const ours = want.colorGroups.find((group) => group.query === query);
      const index = list.findIndex(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          !Array.isArray(item) &&
          item.query === query &&
          ours !== undefined &&
          deepEqual(item.color, ours.color),
      );
      if (index >= 0) text = removeItem(text, ['colorGroups'], index);
      else if (
        list.some((item) => typeof item === 'object' && item !== null && !Array.isArray(item) && item.query === query)
      ) {
        kept.push(`grupo de cor "${query}" (a cor mudou depois do setup)`);
      }
    }
  } else {
    for (const name of added.types ?? []) {
      const have = valueAt(text, ['types', name]);
      if (have === undefined) continue;
      if (have === want.types[name]) text = removeKey(text, ['types'], name);
      else kept.push(`tipo de ${name} (mudou depois do setup)`);
    }
  }
  return { text, kept };
}

/** Junta dois registros do mesmo arquivo (execuções diferentes do setup), sem repetição. */
export function mergeAdded(a: Added | undefined, b: Added): Added {
  const union = (x: string[] | undefined, y: string[] | undefined): string[] => [
    ...new Set([...(x ?? []), ...(y ?? [])]),
  ];
  const items: Record<string, string[]> = { ...(a?.items ?? {}) };
  for (const [key, list] of Object.entries(b.items ?? {})) items[key] = union(items[key], list);
  return {
    ...(a?.created === true || b.created === true ? { created: true } : {}),
    keys: union(a?.keys, b.keys),
    items,
    groups: union(a?.groups, b.groups),
    types: union(a?.types, b.types),
  };
}
