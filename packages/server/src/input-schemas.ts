// Esquemas de ENTRADA das tools, num módulo à parte (`@cabecao/server/input-schemas`): a CLI confere com eles a
// entrada dos comandos que espelham as tools (`remember`, `write`, `patch`, `relate`, `handoff`, `read`...), com os
// mesmos limites de tamanho, sem carregar o SDK do MCP. Só o Zod e os enums do núcleo entram aqui.
export { INPUT_LIMITS, patchPageInput, readInput, rememberInput, undoInput, writePageInput } from './schemas.ts';
export { relateInput } from './schemas-graph.ts';
export { forgetInput, handoffSaveInput, ingestInput } from './schemas-lifecycle.ts';
