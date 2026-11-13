// O caminho com um TERMINAL CONTROLADOR de verdade: a CLI roda (pela fonte, num processo próprio) dentro de um
// pseudo-terminal aberto pelo `pty` da biblioteca padrão do Python, com o stdin redirecionado para um pipe com o
// conteúdo, e a confirmação é respondida pelo terminal. Fora do terminal (o mesmo comando sem PTY), quem roda é um
// agente. Pulado no Windows e onde não há `python3` ou o Node não roda TypeScript direto.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { AGENT_SIGNALS } from '../src/actor.ts';
import { brainRepo, disposeSandbox, freshDir, readNote, TEST_TIMEOUT_MS } from './helpers.ts';

afterAll(disposeSandbox);

const DRIVER = fileURLToPath(new URL('./pty-driver.py', import.meta.url));
const BIN = fileURLToPath(new URL('../src/bin.ts', import.meta.url));

function available(): boolean {
  if (process.platform === 'win32') return false;
  const python = spawnSync('python3', ['-c', 'import pty, json'], { encoding: 'utf8' });
  const node = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
  return python.status === 0 && node.status === 0;
}

/** O ambiente de um usuário no terminal: sem nenhuma variável de agente (a deste próprio processo de teste) e sem CI. */
function humanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CABECAO_CONFIG_DIR: join(freshDir('config pty'), 'cfg') };
  for (const signal of AGENT_SIGNALS) delete env[signal.variable];
  delete env.CI;
  return env;
}

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

describe.skipIf(!available())('terminal controlador de verdade (PTY)', { timeout: TEST_TIMEOUT_MS }, () => {
  it('com o stdin num pipe, o usuário no terminal confirma a regra digitando; sem terminal, é agente', async () => {
    const brain = await brainRepo();
    const env = humanEnv();
    const command = `printf 'Nunca faça deploy na sexta.\\nsim\\n' | ${quote(process.execPath)} ${quote(BIN)} remember --type rule --title 'Sem deploy na sexta' --brain ${quote(brain)}`;
    const run = spawnSync('python3', [DRIVER, 'Digite "sim"', 'sim', 'sh', '-c', command], { env, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout) as { code: number; answered: boolean; output: string };
    expect(result.answered, result.output).toBe(true);
    expect(result.code, result.output).toBe(0);
    const text = await readNote(brain, 'memory/rules/sem-deploy-na-sexta.md');
    expect(text).toContain('origin: human');
    // o "sim" do stdin é conteúdo, não a resposta
    expect(text).toContain('Nunca faça deploy na sexta.\nsim');

    // o mesmo comando, sem terminal controlador (como o Bash de um agente): pede confirmação e não grava
    // `setsid`: uma sessão nova, sem terminal controlador (mesmo quando o teste roda num terminal)
    const headless = spawnSync(
      'python3',
      [
        '-c',
        'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])',
        'sh',
        '-c',
        command.replace("'Sem deploy na sexta'", "'Outra regra'"),
      ],
      { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(headless.status, headless.stderr).toBe(3);
    expect(headless.stdout).toContain('--confirm cbc_ct_');
  });
});
