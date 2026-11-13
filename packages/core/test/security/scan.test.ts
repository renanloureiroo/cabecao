// Testes e medição do scanner de segredos.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALLOW_SECRET_MARKER,
  redactSecret,
  SECRET_RULE_IDS,
  SECRET_RULES,
  scanSecrets,
} from '../../src/security/index.ts';
import { buildNegatives, buildPositives, fake } from './corpus.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const githubToken = (seed: number) => `ghp_${fake(BASE62, 36, seed)}`;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/** Roda o scanner sobre todos os arquivos de uma pasta do repositório, sem respeitar marcador de allowlist. */
function scanTree(folder: string): { files: number; findings: string[] } {
  const files = walk(join(ROOT, folder));
  const findings = files.flatMap((file) =>
    scanSecrets(readFileSync(file, 'utf8'), { honorAllowMarker: false }).map(
      (f) => `${relative(ROOT, file).split(sep).join('/')}:${f.line}:${f.column} ${f.rule} ${f.match}`,
    ),
  );
  return { files: files.length, findings };
}

describe('medição: falsos negativos', () => {
  const positives = buildPositives();

  it('detecta todos os positivos do corpus', () => {
    const missed = positives.filter((c) => scanSecrets(c.text).length === 0).map((c) => c.name);
    expect(missed).toEqual([]);
    expect(positives.length).toBeGreaterThanOrEqual(50);
  });

  it('o corpus cobre todas as regras', () => {
    expect([...new Set(positives.map((c) => c.rule))].sort()).toEqual([...SECRET_RULE_IDS].sort());
  });

  it.each(positives)('$name', ({ rule, secret, text }) => {
    const findings = scanSecrets(text);
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding?.rule).toBe(rule);

    // A posição aponta para o primeiro caractere do segredo.
    const index = text.indexOf(secret);
    const before = text.slice(0, index).split('\n');
    expect(finding?.line).toBe(before.length);
    expect(finding?.column).toBe((before.at(-1) ?? '').length + 1);

    // A redação nunca traz o segredo (o cabeçalho de uma chave privada não é segredo).
    if (rule !== 'private-key') {
      expect(finding?.match).not.toContain(secret);
      expect(finding?.match).not.toContain(secret.slice(0, 8));
      expect(JSON.stringify(finding)).not.toContain(secret.length > 40 ? secret.slice(-20) : secret.slice(-6));
    }
  });
});

describe('medição: falsos positivos', () => {
  const negatives = buildNegatives();

  it('não acusa nenhum negativo do corpus', () => {
    const accused = negatives.flatMap((c) => scanSecrets(c.text).map((f) => `${c.name}: ${f.rule} ${f.match}`));
    expect(accused).toEqual([]);
    expect(negatives.length).toBeGreaterThanOrEqual(60);
  });

  it.each(negatives)('$name', ({ text }) => {
    expect(scanSecrets(text)).toEqual([]);
  });

  it('zero falsos positivos em todas as notas de fixtures/vault', () => {
    const { files, findings } = scanTree('fixtures/vault');
    expect(files).toBeGreaterThan(20);
    expect(findings).toEqual([]);
  });

  it('zero falsos positivos nos documentos de docs/', () => {
    const { files, findings } = scanTree('docs');
    expect(files).toBeGreaterThan(10);
    expect(findings).toEqual([]);
  });

  it('continua detectando um segredo plantado numa nota real do fixture', () => {
    const file = join(ROOT, 'fixtures/vault/memory/rules/nunca-commitar-segredos.md');
    const note = readFileSync(file, 'utf8');
    const lines = note.split('\n');
    const planted = [...lines, `O token antigo era ${githubToken(300)}, já revogado.`].join('\n');
    expect(scanSecrets(planted)).toMatchObject([{ rule: 'github-token', line: lines.length + 1, column: 20 }]);
  });
});

describe('scanSecrets', () => {
  it('devolve lista vazia para texto vazio ou sem segredo', () => {
    expect(scanSecrets('')).toEqual([]);
    expect(scanSecrets('Só uma nota comum, em português, sem nada sensível.\n')).toEqual([]);
  });

  it('devolve os achados na ordem do texto, com linha e coluna a partir de 1', () => {
    const text = `linha um\n  a: ${githubToken(1)}\n\nnpm: npm_${fake(BASE62, 36, 2)} e ${githubToken(3)}\n`;
    expect(scanSecrets(text).map((f) => [f.rule, f.line, f.column])).toEqual([
      ['github-token', 2, 6],
      ['npm-token', 4, 6],
      ['github-token', 4, 49],
    ]);
  });

  it('conta linhas igual com CRLF', () => {
    const text = `um\r\ndois\r\ntoken ${githubToken(4)}\r\n`;
    expect(scanSecrets(text)).toMatchObject([{ line: 3, column: 7 }]);
  });

  it('conta colunas em unidades UTF-16, depois de acentos e emoji', () => {
    const prefix = 'coração 🧠: ';
    expect(scanSecrets(prefix + githubToken(5))).toMatchObject([{ line: 1, column: prefix.length + 1 }]);
  });

  it('em sobreposição, fica só o achado da regra mais específica', () => {
    const secret = githubToken(6);
    expect(scanSecrets(`token=${secret}`).map((f) => f.rule)).toEqual(['github-token']);
    expect(scanSecrets(`https://ci:${secret}@github.com/x/y.git`).map((f) => f.rule)).toEqual(['github-token']);
    const awsSecret = fake(`${BASE62}+/`, 40, 7);
    expect(scanSecrets(`aws_secret_access_key=${awsSecret}`).map((f) => f.rule)).toEqual(['aws-secret-access-key']);
  });

  it('acha os dois lados de uma credencial da AWS', () => {
    const text = `aws_access_key_id = AKIA${fake('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 16, 8)}\naws_secret_access_key = ${fake(`${BASE62}+/`, 40, 9)}\n`;
    expect(scanSecrets(text).map((f) => [f.rule, f.line])).toEqual([
      ['aws-access-key-id', 1],
      ['aws-secret-access-key', 2],
    ]);
  });

  it('é pura: a mesma entrada dá sempre a mesma saída', () => {
    const text = `a ${githubToken(10)} b`;
    expect(scanSecrets(text)).toEqual(scanSecrets(text));
    expect(scanSecrets(text)).toHaveLength(1);
  });

  it('traz a descrição da regra no achado', () => {
    const [finding] = scanSecrets(githubToken(11));
    expect(finding?.description).toBe(SECRET_RULES.find((r) => r.id === 'github-token')?.description);
  });

  it('toda regra tem id único e descrição', () => {
    expect(SECRET_RULES.map((r) => r.id)).toEqual([...SECRET_RULE_IDS]);
    expect(new Set(SECRET_RULE_IDS).size).toBe(SECRET_RULE_IDS.length);
    for (const rule of SECRET_RULES) expect(rule.description.length).toBeGreaterThan(20);
  });
});

describe('redactSecret', () => {
  it('mostra no máximo 4 caracteres e o tamanho', () => {
    const secret = githubToken(12);
    expect(redactSecret(secret)).toBe('ghp_…(40 caracteres)');
    expect(redactSecret('abc12345')).toBe('ab…(8 caracteres)');
    expect(redactSecret('abc')).toBe('…(3 caracteres)');
  });
});

describe('allowlist', () => {
  const secret = githubToken(20);

  it('o marcador é o documentado', () => {
    expect(ALLOW_SECRET_MARKER).toBe('cabecao:allow-secret');
  });

  it('libera a linha que contém o marcador', () => {
    expect(scanSecrets(`token: ${secret} # ${ALLOW_SECRET_MARKER}`)).toEqual([]);
    expect(scanSecrets(`Exemplo: ${secret} <!-- ${ALLOW_SECRET_MARKER} -->`)).toEqual([]);
  });

  it('uma linha só com o marcador libera a linha seguinte, e só ela', () => {
    for (const comment of [
      `<!-- ${ALLOW_SECRET_MARKER} -->`,
      `# ${ALLOW_SECRET_MARKER}`,
      `%% ${ALLOW_SECRET_MARKER} %%`,
    ]) {
      const text = `${comment}\n${secret}\n${secret}\n`;
      expect(scanSecrets(text)).toMatchObject([{ line: 3 }]);
    }
  });

  it('o marcador no meio de uma frase não libera a linha seguinte', () => {
    expect(scanSecrets(`Use ${ALLOW_SECRET_MARKER} para liberar.\n${secret}`)).toMatchObject([{ line: 2 }]);
  });

  it('o marcador não libera linhas anteriores nem distantes', () => {
    expect(scanSecrets(`${secret}\n<!-- ${ALLOW_SECRET_MARKER} -->\n\n${secret}`).map((f) => f.line)).toEqual([1, 4]);
  });

  it('libera uma chave privada inteira pela linha do cabeçalho', () => {
    const key = buildPositives().find((c) => c.name === 'chave RSA em PEM');
    const text = `<!-- ${ALLOW_SECRET_MARKER} -->\n${key?.text.slice(key.text.indexOf(key.secret))}`;
    expect(scanSecrets(text)).toEqual([]);
    expect(scanSecrets(text, { honorAllowMarker: false })).toMatchObject([{ rule: 'private-key', line: 2 }]);
  });

  it('honorAllowMarker: false ignora o marcador', () => {
    const text = `token: ${secret} # ${ALLOW_SECRET_MARKER}`;
    expect(scanSecrets(text, { honorAllowMarker: false })).toHaveLength(1);
    expect(scanSecrets(text, { honorAllowMarker: true })).toEqual([]);
  });
});

describe('desempenho', () => {
  const SIZE = 2_000_000;
  const LIMIT_MS = 3_000;
  const fill = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length));

  // Entradas feitas para provocar retrocesso em expressões regulares mal escritas:
  // prefixos e palavras-chave repetidos, corridas longas da mesma classe, quase-ocorrências sem fim.
  const adversarial: [string, string][] = [
    ['uma linha só de letras', fill('a')],
    ['só quebras de linha', fill('\n')],
    ['espaços e tabs', fill(' \t')],
    ['hifens', fill('-')],
    ['prefixo de JWT repetido', fill('eyJ')],
    ['quase-JWT sem assinatura', fill('eyJhbGciOiJIUzI1NiJ9.')],
    ['quase-JWT com pontos', fill('eyJaaaaaaaaaa.eyJ')],
    ['sk- repetido', fill('sk-')],
    ['sk-ant- repetido', fill('sk-ant-')],
    ['ghp_ repetido', fill('ghp_')],
    ['xoxb- repetido', fill('xoxb-')],
    ['AKIA numa corrida de maiúsculas', `AKIA${fill('A')}`],
    ['AIza numa corrida longa', `AIza${fill('a_')}`],
    ['palavra-chave repetida', fill('token')],
    ['atribuição repetida', fill('token=')],
    ['atribuição com espaços', fill('password =    ')],
    ['atribuição com valor sem fim', `secret=${fill('a1')}`],
    ['nomes compostos sem fim', fill('secret_access_key')],
    ['palavra-chave com sufixo longo', fill('password_a.b-c_')],
    ['início de URL repetido', fill('://a:')],
    ['URL sem arroba', fill(`://u:${'b'.repeat(250)} `)],
    ['URL com usuário sem fim', `https://${fill('u')}`],
    ['cabeçalho de PEM repetido', fill('-----BEGIN ')],
    ['cabeçalho de PEM completo repetido', fill('-----BEGIN RSA PRIVATE KEY-----')],
    ['rótulos de PEM sem fim', `-----BEGIN ${fill('A ')}`],
    ['marcador de allowlist repetido', fill(`${ALLOW_SECRET_MARKER} `)],
  ];

  it.each(adversarial)('entrada adversária de 2 MB: %s', (_name, text) => {
    const started = performance.now();
    scanSecrets(text);
    expect(performance.now() - started).toBeLessThan(LIMIT_MS);
  });

  it('dezenas de milhares de achados, numa linha só e em linhas separadas', () => {
    const count = 40_000;
    for (const separator of [' ', '\n']) {
      const text = Array.from({ length: count }, () => githubToken(30)).join(separator);
      const started = performance.now();
      const findings = scanSecrets(text);
      expect(performance.now() - started).toBeLessThan(LIMIT_MS);
      expect(findings).toHaveLength(count);
      expect(findings.at(-1)).toMatchObject(
        separator === '\n' ? { line: count, column: 1 } : { line: 1, column: (count - 1) * 41 + 1 },
      );
    }
  });

  it('nota grande e realista (5 MB de prosa com hashes) em tempo razoável', () => {
    const paragraph = `${readFileSync(join(ROOT, 'docs/04-sincronizacao.md'), 'utf8')}\ncommit ${fake('0123456789abcdef', 40, 31)}\n`;
    const text = paragraph.repeat(Math.ceil(5_000_000 / paragraph.length));
    const started = performance.now();
    expect(scanSecrets(text)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(LIMIT_MS);
  });
});
