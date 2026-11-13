// Processo filho dos testes: o servidor MCP de verdade, com o stdin e o stdout do processo, como `cabecao mcp`.
// JavaScript puro que importa o TypeScript do servidor.
//   server-child.mjs <cérebro>
import { runStdioServer } from '../src/index.ts';

const [brainRoot] = process.argv.slice(2);
await runStdioServer({ brainRoot, version: '0.0.0-filho', machine: 'maquina-filho' });
process.stderr.write('[server-child] encerrado\n');
