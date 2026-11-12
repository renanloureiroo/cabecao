import type { CommandSpec } from './types.ts';

/**
 * Registro de comandos. Para ligar um comando novo:
 *
 * 1. crie `commands/<nome>.ts` exportando `run(ctx: CommandContext): Promise<CommandResult>`;
 * 2. acrescente aqui uma entrada com `load: () => import('./commands/<nome>.ts')`.
 *
 * No comando: leia `ctx.values`/`ctx.positionals` (já validados), o processo só por `ctx` (`env`, `cwd`, `platform`,
 * `exec`, `stderr` para avisos), a pasta do cérebro por `resolveBrain(ctx)` de `brain.ts`. Devolva
 * `{ text, data, code }`: o roteador escreve `text` ou, com `--json`, `{ ok, command, data }`. Lance `UsageError`
 * (código 2) ou `CliError` (código 1, com `hint` e `code` estável) de `errors.ts`; qualquer outro erro sai sem stack.
 * O `mcp` (servidor de longa duração) também cabe aqui: o `run` só resolve quando o servidor encerra.
 *
 * Este arquivo é avaliado em todo início, inclusive em `--version`: aqui só entram metadados. O `import()`
 * dinâmico faz o bundler gerar um arquivo por comando, carregado só quando o comando roda.
 * `help`, `version`, `json` e `brain` (e as letras `-h` e `-v`) são opções globais e não podem ser redefinidas.
 */
export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'install-client',
    summary: 'Registra o servidor MCP nos clientes de IA',
    usage: [
      'install-client <cliente...> [--npx]',
      'install-client --all [--npx]',
      'install-client --print [cliente...]',
      'install-client --remove <cliente...> | --remove --all',
    ],
    options: {
      all: { type: 'boolean', description: 'Todos os clientes detectados nesta máquina' },
      print: { type: 'boolean', description: 'Só mostra a configuração; não grava nada' },
      remove: { type: 'boolean', description: 'Tira o registro em vez de criar' },
      npx: { type: 'boolean', description: 'Registra como "npx -y cabecao mcp" em vez do caminho direto' },
    },
    details: [
      'Clientes: claude-code, claude-desktop, codex, cursor, vscode, gemini.',
      '',
      'O servidor é registrado como "cabecao mcp --brain <pasta>". Quando a instalação é estável (global ou',
      'local), o registro aponta direto para o Node e para o arquivo do cabecao, o que evita de 0,5 a 1,4 s de',
      'npx a cada início de sessão. Rodando por npx, ou com --npx, o registro usa "npx -y cabecao mcp".',
      '',
      'Os outros servidores e chaves do arquivo do cliente são preservados. Na primeira alteração fica uma',
      'cópia do arquivo original ao lado, com o sufixo .bak.',
    ].join('\n'),
    load: () => import('./commands/install-client.ts'),
  },
];
