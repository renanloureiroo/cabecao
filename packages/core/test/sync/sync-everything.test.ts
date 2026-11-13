// Regressões da revisão do marco 1: "sincronizar TUDO, sem perder arquivo de configuração; só alterar se necessário".
// A6 (o que fica fora das noteDirs sincroniza), A7 (nunca trava nem perde arquivo local), M2 (remoção de cópia de
// conflito da raiz é commitada) e M4 (scanner de segredos para arquivo grande, byte nulo e binário).
import { chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { syncStatus } from '../../src/sync/index.ts';
import { createWorld, exists, git, head, leftovers, note, read, remove, TEST_TIMEOUT_MS, write } from './helpers.ts';

const AT = new Date(2026, 10, 12, 14, 32, 10);
const now = (): Date => AT;
// montadas por partes para nenhum scanner acusar este arquivo de teste
const AWS_KEY = `${'AKIA'}Z7QX4M2PLKJH8NVB`;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function remoteFiles(remote: string, branch = 'main'): Promise<string[]> {
  return (await git(remote, ['ls-tree', '-r', '--name-only', branch])).split('\n');
}

describe.concurrent('sync: tudo o que o git vê sincroniza (A6, M2)', { timeout: TEST_TIMEOUT_MS }, () => {
  it('pasta nova, dashboards/, CLAUDE.md e .obsidian/ entram num commit `edit` só, com a lista, e são enviados', async () => {
    const created = await createWorld();
    const w = created.world;
    const { a } = created;
    try {
      const b = await w.clone('b');
      write(a.dir, 'Projetos/Plano 2027.md', '# Plano\nconteúdo importante\n');
      write(a.dir, 'dashboards/Tarefas.base', 'views: []\n');
      write(a.dir, 'CLAUDE.md', '@AGENTS.md\n');
      write(a.dir, '.obsidian/app.json', '{\n  "x": 1\n}\n');
      // o `status` conta como pendente tudo o que o sync vai commitar
      expect((await syncStatus(a.dir)).pendingChanges).toBe(4);

      const ra = await a.sync();
      expect(ra).toMatchObject({ status: 'ok', committed: 1, pushed: 1, attempts: 1 });
      const message = await git(a.dir, ['log', '-1', '--format=%B']);
      expect(message).toContain('edit: 4 arquivos alterados fora do Cabeção');
      for (const path of ['.obsidian/app.json', 'CLAUDE.md', 'Projetos/Plano 2027.md', 'dashboards/Tarefas.base']) {
        expect(message).toContain(`- ${path}`);
      }
      expect(message).toContain('Cabecao-Client: manual');
      expect(await leftovers(a.dir)).toEqual([]);
      expect((await syncStatus(a.dir)).pendingChanges).toBe(0);
      expect(await remoteFiles(w.remote)).toEqual(
        expect.arrayContaining([
          'Projetos/Plano 2027.md',
          'dashboards/Tarefas.base',
          'CLAUDE.md',
          '.obsidian/app.json',
        ]),
      );

      expect(await b.sync()).toMatchObject({ status: 'ok', pulled: 1 });
      expect(read(b.dir, 'Projetos/Plano 2027.md')).toBe('# Plano\nconteúdo importante\n');
      // nada é reformatado: o arquivo chega byte a byte
      expect(read(b.dir, '.obsidian/app.json')).toBe('{\n  "x": 1\n}\n');
    } finally {
      w.cleanup();
    }
  });

  it('apagar a cópia de conflito de um arquivo da raiz (AGENTS.md) é commitado e enviado', async () => {
    const created = await createWorld({
      files: { 'wiki/x.md': note('Nota X'), 'AGENTS.md': '# Regras\n\n- uma regra\n' },
    });
    const w = created.world;
    const { a } = created;
    try {
      const b = await w.clone('b');
      write(a.dir, 'AGENTS.md', '# Regras A\n\n- uma regra\n');
      write(b.dir, 'AGENTS.md', '# Regras B\n\n- uma regra\n');
      expect(await a.sync()).toMatchObject({ status: 'ok', pushed: 1 });
      const rb = await b.sync({ now });
      expect(rb.status).toBe('ok');
      const copy = 'AGENTS.conflict-b-20261112-143210.md';
      expect(rb.conflicts).toEqual([{ path: 'AGENTS.md', kind: 'content', copy }]);
      expect(read(b.dir, copy)).toBe('# Regras B\n\n- uma regra\n');
      expect(read(b.dir, 'AGENTS.md')).toBe('# Regras A\n\n- uma regra\n');
      // a cópia não entra no catálogo (o banco local também a deixa de fora)
      expect(read(b.dir, 'index.md')).not.toContain('conflict');

      remove(b.dir, copy);
      expect((await syncStatus(b.dir)).pendingChanges).toBe(1);
      const r2 = await b.sync();
      expect(r2).toMatchObject({ status: 'ok', committed: 1, pushed: 1 });
      expect(await git(b.dir, ['ls-tree', '-r', '--name-only', 'HEAD'])).not.toContain(copy);
      expect(await remoteFiles(w.remote)).not.toContain(copy);
      expect(await leftovers(b.dir)).toEqual([]);
    } finally {
      w.cleanup();
    }
  });
});

describe.concurrent('sync: arquivo de configuração nunca se perde nem trava o sync (A7)', {
  timeout: TEST_TIMEOUT_MS,
}, () => {
  it('CLAUDE.md, .gitignore e .obsidian/app.json mudados nas duas máquinas: mescla regiões, preserva as duas versões no conflito, nunca trava', async () => {
    const app = (first: string, last: string): string =>
      `{\n  "a": ${first},\n  "b": 2,\n  "c": 3,\n  "d": 4,\n  "e": 5,\n  "f": 6,\n  "z": ${last}\n}\n`;
    const created = await createWorld({
      files: { 'wiki/x.md': note('Nota X'), 'CLAUDE.md': '@AGENTS.md\n', '.obsidian/app.json': app('1', '9') },
    });
    const w = created.world;
    const { a } = created;
    try {
      const b = await w.clone('b');
      write(a.dir, 'CLAUDE.md', '@AGENTS.md\nInstrução de A\n');
      write(a.dir, '.gitignore', '.cabecao/\na.log\n');
      write(a.dir, '.obsidian/app.json', app('"A"', '9'));
      write(b.dir, 'CLAUDE.md', '@AGENTS.md\nInstrução de B\n');
      write(b.dir, '.gitignore', '.cabecao/\nb.log\n');
      write(b.dir, '.obsidian/app.json', app('1', '"B"'));
      expect(await a.sync()).toMatchObject({ status: 'ok', pushed: 1 });

      const rb = await b.sync({ now });
      expect(rb).toMatchObject({ status: 'ok', attempts: 1, pushed: 2 });
      expect(rb.conflicts).toEqual([
        { path: '.gitignore', kind: 'content', copy: '.gitignore.conflict-b-20261112-143210' },
        { path: 'CLAUDE.md', kind: 'content', copy: 'CLAUDE.conflict-b-20261112-143210.md' },
      ]);
      // conflito de verdade: o caminho fica com a versão remota e a daqui vai para a cópia, byte a byte
      expect(read(b.dir, 'CLAUDE.md')).toBe('@AGENTS.md\nInstrução de A\n');
      expect(read(b.dir, 'CLAUDE.conflict-b-20261112-143210.md')).toBe('@AGENTS.md\nInstrução de B\n');
      expect(read(b.dir, '.gitignore')).toBe('.cabecao/\na.log\n');
      expect(read(b.dir, '.gitignore.conflict-b-20261112-143210')).toBe('.cabecao/\nb.log\n');
      // regiões diferentes: mescladas, sem reformatar
      expect(read(b.dir, '.obsidian/app.json')).toBe(app('"A"', '"B"'));
      const merge = await git(b.dir, ['log', '-1', '--format=%B']);
      expect(merge).toContain('conflict: 2 arquivos com conflito preservado');
      expect(await leftovers(b.dir)).toEqual([]);

      expect(await a.sync()).toMatchObject({ status: 'ok' });
      expect(await head(a.dir)).toBe(await head(b.dir));
      expect(read(a.dir, 'CLAUDE.conflict-b-20261112-143210.md')).toBe('@AGENTS.md\nInstrução de B\n');
    } finally {
      w.cleanup();
    }
  });

  it('arquivo IGNORADO aqui que o remoto passou a versionar: bloqueia citando o arquivo, sem sobrescrever e sem laço', async () => {
    const created = await createWorld();
    const w = created.world;
    const { a } = created;
    try {
      const b = await w.clone('b');
      write(a.dir, '.git/info/exclude', 'rascunho.md\n');
      write(a.dir, 'rascunho.md', 'versão local, ignorada nesta máquina\n');
      write(a.dir, 'wiki/nova.md', note('Nova de A'));
      write(b.dir, 'rascunho.md', 'versão de B, versionada lá\n');
      expect(await b.sync()).toMatchObject({ status: 'ok', pushed: 1 });

      const ra = await a.sync();
      expect(ra).toMatchObject({ status: 'blocked', reason: 'local-file', attempts: 1, pushed: 0 });
      expect(ra.message).toContain('rascunho.md');
      expect(ra.message).toContain('Renomeie ou mova o arquivo local');
      // o arquivo local continua intacto, e a edição de A está num commit local
      expect(read(a.dir, 'rascunho.md')).toBe('versão local, ignorada nesta máquina\n');
      expect(await git(a.dir, ['show', '--name-only', '--format=', 'HEAD'])).toContain('wiki/nova.md');
      expect(await leftovers(a.dir)).toEqual([]);
      // de novo: mesmo bloqueio, nenhum laço de tentativas
      expect(await a.sync()).toMatchObject({ status: 'blocked', reason: 'local-file', attempts: 1 });

      // o usuário segue a instrução
      renameSync(join(a.dir, 'rascunho.md'), join(a.dir, 'rascunho-local.md'));
      const r3 = await a.sync();
      // vão o commit de wiki/nova.md (feito no sync bloqueado) e o do arquivo renomeado
      expect(r3).toMatchObject({ status: 'ok', pushed: 2 });
      expect(read(a.dir, 'rascunho.md')).toBe('versão de B, versionada lá\n');
      expect(read(a.dir, 'rascunho-local.md')).toBe('versão local, ignorada nesta máquina\n');
    } finally {
      w.cleanup();
    }
  });

  it('arquivo ignorado com o MESMO conteúdo do remoto não bloqueia', async () => {
    const created = await createWorld();
    const w = created.world;
    const { a } = created;
    try {
      const b = await w.clone('b');
      write(a.dir, '.git/info/exclude', 'igual.md\n');
      write(a.dir, 'igual.md', 'mesmo conteúdo\n');
      write(b.dir, 'igual.md', 'mesmo conteúdo\n');
      expect(await b.sync()).toMatchObject({ status: 'ok', pushed: 1 });
      expect(await a.sync()).toMatchObject({ status: 'ok', integration: 'fast-forward' });
      expect(read(a.dir, 'igual.md')).toBe('mesmo conteúdo\n');
    } finally {
      w.cleanup();
    }
  });

  it('alteração local num arquivo versionado dentro de .cabecao/ (que o sync nunca commita): bloqueia, sem laço', async () => {
    const created = await createWorld();
    const w = created.world;
    const { a } = created;
    try {
      write(a.dir, '.cabecao/compartilhado.txt', 'base\n');
      await git(a.dir, ['add', '-f', '.cabecao/compartilhado.txt']);
      await git(a.dir, ['commit', '--quiet', '-m', 'versionado por engano']);
      expect(await a.sync()).toMatchObject({ status: 'ok', pushed: 1 });
      const b = await w.clone('b');
      write(b.dir, '.cabecao/compartilhado.txt', 'de B\n');
      await git(b.dir, ['commit', '--quiet', '-am', 'muda em B']);
      await git(b.dir, ['push', '--quiet']);
      write(a.dir, '.cabecao/compartilhado.txt', 'de A\n');

      const ra = await a.sync();
      expect(ra).toMatchObject({ status: 'blocked', reason: 'local-file', attempts: 1 });
      expect(ra.message).toContain('.cabecao/compartilhado.txt');
      expect(read(a.dir, '.cabecao/compartilhado.txt')).toBe('de A\n');
    } finally {
      w.cleanup();
    }
  });

  it('arquivo regravado a cada tentativa durante a aplicação: desiste dizendo qual arquivo e o que fazer; nada se perde', async () => {
    const created = await createWorld();
    const w = created.world;
    const { a } = created;
    try {
      const b = await w.clone('b');
      write(a.dir, 'wiki/x.md', note('Nota X', '\nde A\n'));
      expect(await a.sync()).toMatchObject({ status: 'ok', pushed: 1 });
      let n = 0;
      const rb = await b.sync({
        maxAttempts: 2,
        faultAt: (step) => {
          // o "Obsidian" grava a nota que a integração muda bem na hora da aplicação, em todo ciclo
          if (step === 'journaled') write(b.dir, 'wiki/x.md', note('Nota X', `\ndigitando ${++n}\n`));
        },
      });
      expect(rb).toMatchObject({ status: 'error', attempts: 2 });
      expect(rb.message).toContain('wiki/x.md');
      expect(rb.message).toContain('Feche (ou espere terminar) o programa');
      expect(rb.message).not.toMatch(/Nada se perdeu; rode o sync de novo\.$/);
      expect(read(b.dir, 'wiki/x.md')).toBe(note('Nota X', `\ndigitando ${n}\n`));

      const again = await b.sync({ now });
      expect(again.status).toBe('ok');
      const texts = [read(b.dir, 'wiki/x.md'), ...again.conflicts.map((c) => read(b.dir, c.copy ?? ''))];
      expect(texts).toContain(note('Nota X', `\ndigitando ${n}\n`));
    } finally {
      w.cleanup();
    }
  });
});

describe.concurrent('sync: scanner de segredos vale para tudo (M4)', { timeout: TEST_TIMEOUT_MS }, () => {
  it('texto com mais de 4 MB e .md com byte nulo no começo: bloqueiam, com linha certa; nada vai para o remoto', async () => {
    const created = await createWorld();
    const w = created.world;
    const { a } = created;
    try {
      write(a.dir, 'raw/big-log.md', `${'x'.repeat(5 * 1024 * 1024)}\n${AWS_KEY}\n`);
      write(a.dir, 'raw/nul.md', `\u0000\n${AWS_KEY}\n`);
      const ra = await a.sync();
      expect(ra).toMatchObject({ status: 'blocked', reason: 'secrets', committed: 0, pushed: 0 });
      expect(ra.secrets?.map((s) => [s.path, s.line, s.column, s.where]).sort()).toEqual([
        ['raw/big-log.md', 2, 1, 'pending'],
        ['raw/nul.md', 2, 1, 'pending'],
      ]);
      const files = await remoteFiles(w.remote);
      expect(files).not.toContain('raw/big-log.md');
      expect(files).not.toContain('raw/nul.md');
    } finally {
      w.cleanup();
    }
  });

  it('binário de verdade (extensão E assinatura) não é lido; ".png" que é texto é escaneado', async () => {
    const created = await createWorld();
    const w = created.world;
    const { a } = created;
    try {
      write(a.dir, 'raw/assets/foto.png', Buffer.concat([PNG_MAGIC, Buffer.from(`\u0000\u0000${AWS_KEY}`)]));
      expect(await a.sync()).toMatchObject({ status: 'ok', pushed: 1 });
      write(a.dir, 'raw/assets/falso.png', `não sou imagem\n${AWS_KEY}\n`);
      const ra = await a.sync();
      expect(ra).toMatchObject({ status: 'blocked', reason: 'secrets' });
      expect(ra.secrets?.map((s) => s.path)).toEqual(['raw/assets/falso.png']);
    } finally {
      w.cleanup();
    }
  });

  it('commit feito por fora (git puro) com arquivo grande e segredo: o envio bloqueia', async () => {
    const created = await createWorld();
    const w = created.world;
    const { a } = created;
    try {
      write(a.dir, 'dashboards/export.csv', `${'linha,qualquer\n'.repeat(400_000)}chave,${AWS_KEY}\n`);
      await git(a.dir, ['add', '-A']);
      await git(a.dir, ['commit', '--quiet', '-m', 'exportação']);
      const ra = await a.sync();
      expect(ra).toMatchObject({ status: 'blocked', reason: 'secrets', pushed: 0 });
      expect(ra.secrets).toEqual([
        expect.objectContaining({ path: 'dashboards/export.csv', line: 400_001, where: 'outgoing' }),
      ]);
      expect(await remoteFiles(w.remote)).not.toContain('dashboards/export.csv');
    } finally {
      w.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'arquivo que não dá para ler: bloqueia (unscannable) citando o arquivo, sem commitar',
    async () => {
      const created = await createWorld();
      const w = created.world;
      const { a } = created;
      const file = join(a.dir, 'wiki', 'trancado.md');
      try {
        write(a.dir, 'wiki/trancado.md', note('Trancado'));
        chmodSync(file, 0o000);
        const ra = await a.sync();
        expect(ra).toMatchObject({ status: 'blocked', reason: 'unscannable', committed: 0, pushed: 0 });
        expect(ra.message).toContain('wiki/trancado.md');
        chmodSync(file, 0o644);
        expect(await a.sync()).toMatchObject({ status: 'ok', pushed: 1 });
        expect(exists(a.dir, 'wiki/trancado.md')).toBe(true);
      } finally {
        chmodSync(file, 0o644);
        w.cleanup();
      }
    },
  );
});
