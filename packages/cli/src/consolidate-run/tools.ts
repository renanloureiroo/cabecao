// Os nomes das tools do servidor MCP, copiados aqui para a CLI não carregar o servidor (SDK do MCP e Zod) só para
// montar a configuração de um agente. Um teste confere que a lista continua igual à `TOOL_NAMES` do servidor.
export const SERVER_TOOL_NAMES = [
  'recall',
  'search',
  'read',
  'graph',
  'facts',
  'status',
  'lint',
  'remember',
  'handoff_save',
  'write_page',
  'patch_page',
  'relate',
  'ingest',
  'forget',
  'sync',
  'consolidate',
  'undo',
] as const;
