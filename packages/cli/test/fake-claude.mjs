// Claude Code FALSO para os testes do provedor "agente instalado": nunca chama modelo nenhum. Uso:
//   node fake-claude.mjs <arquivo-de-log> <modo> [argumentos do claude...]
// Grava no log os argumentos, as variáveis de ambiente recebidas (só os nomes) e a pasta de trabalho; lê o prompt da
// entrada padrão e responde como o `claude -p --output-format json --json-schema`, conforme o modo:
//   ok      responde citando o primeiro trecho (primeira frase, literal);
//   auth    "Not logged in";
//   noschema  sucesso sem structured_output;
//   sleep   sobe um processo neto e dorme (para testar tempo limite e a derrubada da árvore).
import { spawn } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';

const [, , logPath, mode, ...args] = process.argv;
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  writeFileSync(
    logPath,
    JSON.stringify({
      args,
      env: Object.keys(process.env).sort(),
      cwd: process.cwd(),
      cwdFiles: readdirSync(process.cwd()),
      stdin: input,
    }),
  );
  if (mode === 'sleep') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeFileSync(`${logPath}.neto`, String(child.pid));
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'auth') {
    process.stdout.write(
      `${JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })}\n`,
    );
    process.exit(1);
  }
  if (mode === 'noschema') {
    process.stdout.write(
      `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'não quero' })}\n`,
    );
    return;
  }
  const marker = /Marca dos delimitadores desta mensagem: ([0-9a-f]+)/.exec(input)?.[1];
  const match = new RegExp(`<<<TRECHO ${marker} (S\\d+)>>>\\n[\\s\\S]*?\\n---\\n([\\s\\S]*?)\\n<<<FIM`).exec(input);
  const label = match?.[1] ?? 'S1';
  const sentence =
    (match?.[2] ?? '')
      .replace(/\^/g, ' ')
      .split(/(?<=[.!?])\s+/)[0]
      ?.trim()
      .slice(0, 150) ?? '';
  process.stdout.write(
    `${JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      structured_output: {
        status: 'answered',
        claims: [{ text: sentence, sources: [label], quote: sentence }],
        missing: '',
      },
      total_cost_usd: 0.0012,
      usage: { input_tokens: 900, output_tokens: 80 },
    })}\n`,
  );
});
