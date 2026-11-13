// Onde cada cliente de IA lê as skills (formato Agent Skills: `<pasta>/<nome>/SKILL.md`). Só metadados e caminhos:
// nenhum arquivo é lido aqui. Fontes conferidas em 13/11/2026 (marcadas no código: "confirmado" é a documentação
// oficial; "suposição" é o que ela não diz):
//
// - Claude Code: `~/.claude/skills` e `.claude/skills` no projeto (code.claude.com/docs/en/skills, confirmado). Que
//   `CLAUDE_CONFIG_DIR` leve as skills para `$CLAUDE_CONFIG_DIR/skills` é suposição (a variável troca a pasta inteira).
// - Codex: `~/.agents/skills` e `.agents/skills` (developers.openai.com/codex/skills, confirmado).
// - Cursor: lê `~/.agents/skills` e `.agents/skills` (além de `~/.cursor/skills`, `~/.claude/skills`...;
//   cursor.com/docs/context/skills, confirmado). A pasta comum evita a mesma skill em dobro com o Codex.
// - Gemini CLI: `~/.agents/skills` é um apelido de `~/.gemini/skills`, e `.agents/skills` vale no projeto
//   (geminicli.com/docs/cli/skills, confirmado).
// - Antigravity (agy, IDE e App): `~/.gemini/config/skills` e `.agents/skills` (antigravity.google/docs/skills,
//   confirmado).
// - VS Code e GitHub Copilot: `~/.copilot/skills` e `.github/skills` (code.visualstudio.com/docs/copilot/customization/
//   agent-skills, página de 11/11/2026, confirmado). `COPILOT_HOME` troca `~/.copilot` (docs.github.com, confirmado);
//   que as skills sigam junto é suposição.
// - Claude Desktop: não tem pasta de skills no disco documentada (as skills entram pela interface) e não roda comandos
//   de terminal: lá o caminho é o servidor MCP (`.mcpb` ou `install-client`).
// - No Windows, as mesmas pastas dentro de %USERPROFILE% (suposição: as documentações só mostram `~`).
import { posix, win32 } from 'node:path';
import type { ClientId, Location } from '../install-client/clients.ts';

export type SkillScope = 'user' | 'project';

/** Clientes que leem skills de uma pasta no disco, na ordem fixa. */
export const SKILL_CLIENTS = ['claude-code', 'codex', 'cursor', 'vscode', 'antigravity', 'gemini'] as const;
export type SkillClientId = (typeof SKILL_CLIENTS)[number];

export function isSkillClient(id: string): id is SkillClientId {
  return (SKILL_CLIENTS as readonly string[]).includes(id);
}

/** Por que um cliente conhecido não recebe skills. */
export const NO_SKILLS: Readonly<Partial<Record<ClientId, string>>> = {
  'claude-desktop':
    'o Claude Desktop não roda comandos de terminal e não tem pasta de skills no disco: lá o Cabeção entra pelo servidor MCP (o pacote .mcpb ou "cabecao install-client claude-desktop")',
};

function pathFor(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix;
}

function envDir(location: Location, name: string): string | undefined {
  const value = location.env[name];
  return value !== undefined && value !== '' && pathFor(location.platform).isAbsolute(value) ? value : undefined;
}

/** Pasta de skills do cliente para o usuário (padrão) ou para o projeto em `cwd`. */
export function skillsDir(client: SkillClientId, scope: SkillScope, location: Location, cwd: string): string {
  const path = pathFor(location.platform);
  if (scope === 'project') {
    if (client === 'claude-code') return path.join(cwd, '.claude', 'skills');
    if (client === 'vscode') return path.join(cwd, '.github', 'skills');
    return path.join(cwd, '.agents', 'skills');
  }
  const home = location.home;
  switch (client) {
    case 'claude-code':
      return path.join(envDir(location, 'CLAUDE_CONFIG_DIR') ?? path.join(home, '.claude'), 'skills');
    case 'vscode':
      return path.join(envDir(location, 'COPILOT_HOME') ?? path.join(home, '.copilot'), 'skills');
    case 'antigravity':
      return path.join(home, '.gemini', 'config', 'skills');
    default:
      return path.join(home, '.agents', 'skills');
  }
}
