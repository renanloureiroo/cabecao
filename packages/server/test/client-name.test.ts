import { describe, expect, it } from 'vitest';
import { FALLBACK_CLIENT, resolveClientName } from '../src/index.ts';

describe('resolveClientName', () => {
  it.each([
    ['claude-code', 'claude-code'],
    ['Claude Code', 'claude-code'],
    ['claude-ai', 'claude-desktop'],
    ['Claude Desktop', 'claude-desktop'],
    ['codex-mcp-client', 'codex'],
    ['Codex', 'codex'],
    ['cursor-vscode', 'cursor'],
    ['Visual Studio Code', 'vscode'],
    ['gemini-cli-mcp-client', 'gemini-cli'],
    ['windsurf-client', 'windsurf'],
    ['Zed', 'zed'],
  ])('nome conhecido: %s → %s', (announced, expected) => {
    expect(resolveClientName(announced)).toBe(expected);
  });

  it.each([
    ['meu-cliente', 'meu-cliente'],
    ['Meu Cliente 2.0', 'meu-cliente-2.0'],
    ['Ágil/Cliente!', 'agil-cliente'],
    ['__x', 'x'],
    ['a'.repeat(100), 'a'.repeat(64)],
  ])('saneado: %s → %s', (announced, expected) => {
    expect(resolveClientName(announced)).toBe(expected);
  });

  it.each([[undefined], [null], [42], [''], ['   '], ['!!!'], ['cli'], ['manual'], ['CLI']])(
    'sem nome aproveitável ou reservado (%s) → mcp',
    (announced) => {
      expect(resolveClientName(announced)).toBe(FALLBACK_CLIENT);
    },
  );
});
