import type { Exec } from './types.ts';

/** Executor real, sem shell. O `node:child_process` só é carregado quando um comando de fato roda um programa. */
export const systemExec: Exec = async (file, args, options = {}) => {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        timeout: options.timeoutMs ?? 30_000,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error === null) return resolve({ code: 0, stdout, stderr });
        const code = typeof error.code === 'number' ? error.code : null;
        resolve({ code, stdout, stderr: stderr === '' ? error.message : stderr });
      },
    );
  });
};
