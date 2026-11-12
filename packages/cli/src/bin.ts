#!/usr/bin/env node
// Entrada do bin. Confere a versão do Node antes de carregar qualquer outro módulo.
// Não detecta "sou o módulo principal?": isso falha quando o bin roda pelo symlink de node_modules/.bin.
import { unsupportedNodeMessage } from './node-version.ts';

const problem = unsupportedNodeMessage(process.versions.node);
if (problem) {
  process.stderr.write(`${problem}\n`);
  process.exit(1);
}

import('./main.ts').then(
  ({ main }) => main(process.argv.slice(2)),
  (error: unknown) => {
    process.stderr.write(`cabecao: falha ao iniciar: ${String(error)}\n`);
    process.exit(1);
  },
);
