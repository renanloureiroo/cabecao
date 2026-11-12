// API pública do servidor MCP do Cabeção. A CLI (`cabecao mcp`) usa `runStdioServer`; o resto existe para testes e
// para o modo HTTP que virá depois.
export type { BrainProvider, BrainProviderOptions } from './brains.ts';
export { createBrainProvider } from './brains.ts';
export { FALLBACK_CLIENT, resolveClientName } from './client-name.ts';
export { SERVER_INSTRUCTIONS } from './instructions.ts';
export type { ServerErrorCode, ToolErrorJson } from './results.ts';
export { buildServer, serverInfo } from './server.ts';
export type { StdioServerOptions } from './stdio.ts';
export { runStdioServer } from './stdio.ts';
export type { ServerRuntime, SyncRunner } from './tools.ts';
export { TOOL_NAMES } from './tools.ts';
