// Nome do cliente MCP para os commits: o que o cliente anuncia (`clientInfo.name`, no `initialize` da geração
// 2025-11-25 ou no envelope `_meta` de cada requisição da geração 2026-07-28) vira o `client` do `openBrain`, que
// vai para `origin: agent:<cliente>` e para o rodapé `Cabecao-Client`.

/** Recuo quando o cliente não se identifica, ou se identifica com um nome que não serve. */
export const FALLBACK_CLIENT = 'mcp';

/** Mesmo formato que `openBrain` aceita. */
const CLIENT_RE = /^[A-Za-z0-9][\w.-]{0,63}$/;

/**
 * Nomes que o núcleo trata de forma especial e que um cliente MCP não pode assumir: `cli` é o usuário na linha de
 * comando (o servidor passa `actor: 'agent'` de qualquer jeito, mas o rodapé mentiria) e `manual` marca edições
 * feitas fora do Cabeção, que o `undo` ignora.
 */
const RESERVED = new Set(['cli', 'manual']);

/** Nomes conhecidos, como os clientes os anunciam, para o nome curto usado nos commits. Testados em ordem. */
const KNOWN: readonly (readonly [RegExp, string])[] = [
  [/^claude[-_ ]?code\b/, 'claude-code'],
  [/^claude[-_ ]?(?:ai|desktop)\b/, 'claude-desktop'],
  [/codex/, 'codex'],
  [/cursor/, 'cursor'],
  [/^(?:visual[-_ ]?studio[-_ ]?code|vs[-_ ]?code)\b/, 'vscode'],
  [/antigravity|^agy\b/, 'antigravity'],
  [/^gemini/, 'gemini-cli'],
  [/windsurf/, 'windsurf'],
  [/^zed\b/, 'zed'],
  [/^goose\b/, 'goose'],
  [/^opencode\b/, 'opencode'],
  [/^continue\b/, 'continue'],
  [/^cline\b/, 'cline'],
];

/**
 * Converte o nome anunciado pelo cliente no nome usado nos commits. Nomes conhecidos viram a forma curta
 * (`claude-ai` → `claude-desktop`, `codex-mcp-client` → `codex`); os demais são saneados (minúsculas; o que não é
 * letra, dígito, `.`, `_` ou `-` vira `-`; até 64 caracteres). Sem nome aproveitável, `mcp`.
 */
export function resolveClientName(announced: unknown): string {
  if (typeof announced !== 'string') return FALLBACK_CLIENT;
  const lower = announced.normalize('NFKD').replace(/\p{M}/gu, '').trim().toLowerCase();
  for (const [pattern, name] of KNOWN) if (pattern.test(lower)) return name;
  const cleaned = lower
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64)
    .replace(/[.-]+$/, '');
  if (cleaned === '' || RESERVED.has(cleaned) || !CLIENT_RE.test(cleaned)) return FALLBACK_CLIENT;
  return cleaned;
}
