// Corpus de medição do scanner de segredos.
//
// Todos os "segredos" daqui são FALSOS e montados em tempo de execução, por concatenação de um
// prefixo com um corpo pseudoaleatório determinístico. Nenhum aparece inteiro neste arquivo, para
// que scanners de terceiros (como o push protection do GitHub) não tenham o que bloquear.
import type { SecretRuleId } from '../../src/security/index.ts';

export interface PositiveCase {
  name: string;
  rule: SecretRuleId;
  /** O segredo falso, para conferir a redação e a posição. */
  secret: string;
  /** Texto de nota que contém o segredo. */
  text: string;
}

export interface NegativeCase {
  name: string;
  text: string;
}

const DIGITS = '0123456789';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const BASE62 = UPPER + LOWER + DIGITS;
const HEX = `${DIGITS}abcdef`;
const BASE64 = `${BASE62}+/`;
const BASE64URL = `${BASE62}-_`;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Gerador determinístico (mulberry32): o corpus é o mesmo em toda execução e em toda plataforma. */
export function fake(alphabet: string, length: number, seed: number): string {
  let state = seed >>> 0;
  let out = '';
  for (let i = 0; i < length; i++) {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out += alphabet.charAt(((t ^ (t >>> 14)) >>> 0) % alphabet.length);
  }
  return out;
}

const base64Lines = (seed: number, lines = 4) =>
  Array.from({ length: lines }, (_, i) => fake(BASE64, 64, seed + i)).join('\n');
const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

const BEGIN = `${'-'.repeat(5)}BEGIN `;
const END = `${'-'.repeat(5)}END `;
const PRIVATE = `PRIVATE KEY${'-'.repeat(5)}`;
const pemHeader = (label: string) => `${BEGIN}${label}${PRIVATE}`;
const pemFooter = (label: string) => `${END}${label}${PRIVATE}`;

function positive(
  name: string,
  rule: SecretRuleId,
  secret: string,
  wrap: (secret: string) => string = (s) => s,
): PositiveCase {
  return { name, rule, secret, text: wrap(secret) };
}

export function buildPositives(): PositiveCase[] {
  const jwt = [
    base64url({ alg: 'HS256', typ: 'JWT' }),
    base64url({ sub: 'ana.prado', name: 'Ana Prado', iat: 1762900000 }),
    fake(BASE64URL, 43, 101),
  ].join('.');

  return [
    // Chaves privadas: o achado é o cabeçalho.
    positive(
      'chave RSA em PEM',
      'private-key',
      pemHeader('RSA '),
      (h) => `Chave do deploy:\n\n${h}\n${base64Lines(1)}\n${pemFooter('RSA ')}\n`,
    ),
    positive(
      'chave PKCS#8 sem rótulo',
      'private-key',
      pemHeader(''),
      (h) => `${h}\n${base64Lines(5)}\n${pemFooter('')}`,
    ),
    positive(
      'chave EC em bloco de código',
      'private-key',
      pemHeader('EC '),
      (h) => `\`\`\`\n${h}\n${base64Lines(9, 2)}\n${pemFooter('EC ')}\n\`\`\``,
    ),
    positive(
      'chave OpenSSH',
      'private-key',
      pemHeader('OPENSSH '),
      (h) => `${h}\nb3BlbnNzaC1rZXktdjEAAAAA${fake(BASE64, 40, 13)}\n${base64Lines(14)}\n${pemFooter('OPENSSH ')}`,
    ),
    positive(
      'chave PEM cifrada (cabeçalhos Proc-Type)',
      'private-key',
      pemHeader('RSA '),
      (h) =>
        `${h}\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,${fake(HEX, 32, 18)}\n\n${base64Lines(19)}\n${pemFooter('RSA ')}`,
    ),
    positive(
      'chave PEM dentro de JSON, com \\n escrito',
      'private-key',
      pemHeader(''),
      (h) => `{"private_key": "${h}\\n${fake(BASE64, 64, 23)}\\n${fake(BASE64, 64, 24)}\\n${pemFooter('')}\\n"}`,
    ),
    positive(
      'chave PEM com CRLF',
      'private-key',
      pemHeader('RSA '),
      (h) => `${h}\r\n${fake(BASE64, 64, 25)}\r\n${fake(BASE64, 64, 26)}\r\n${pemFooter('RSA ')}\r\n`,
    ),
    positive(
      'chave privada PGP',
      'private-key',
      `${BEGIN}PGP ${PRIVATE.replace('KEY', 'KEY BLOCK')}`,
      (h) => `${h}\nVersion: GnuPG v2\n\n${base64Lines(27)}\n`,
    ),
    positive(
      'chave PEM em citação de Markdown',
      'private-key',
      pemHeader('RSA '),
      (h) => `> ${h}\n> ${fake(BASE64, 64, 31)}\n> ${fake(BASE64, 64, 32)}`,
    ),

    // AWS
    positive(
      'AWS access key id permanente',
      'aws-access-key-id',
      `AKIA${fake(UPPER + DIGITS, 16, 40)}`,
      (s) => `A chave de acesso do bucket é ${s}.`,
    ),
    positive(
      'AWS access key id temporária',
      'aws-access-key-id',
      `ASIA${fake(UPPER + DIGITS, 16, 41)}`,
      (s) => `AWS_ACCESS_KEY_ID=${s}`,
    ),
    positive(
      'AWS secret em arquivo de credenciais',
      'aws-secret-access-key',
      fake(BASE64, 40, 42),
      (s) => `[default]\naws_secret_access_key = ${s}\n`,
    ),
    positive(
      'AWS secret em JSON',
      'aws-secret-access-key',
      fake(BASE64, 40, 43),
      (s) => `{ "SecretAccessKey": "${s}" }`,
    ),
    positive(
      'AWS secret em variável de ambiente',
      'aws-secret-access-key',
      fake(BASE64, 40, 44),
      (s) => `export AWS_SECRET_ACCESS_KEY=${s}`,
    ),

    // GitHub
    positive(
      'GitHub token pessoal',
      'github-token',
      `ghp_${fake(BASE62, 36, 50)}`,
      (s) => `Usei o token ${s} para clonar.`,
    ),
    positive('GitHub token de corpo repetido', 'github-token', `ghp_${'A'.repeat(36)}`, (s) => `token do CI: ${s}`),
    positive('GitHub token OAuth', 'github-token', `gho_${fake(BASE62, 36, 51)}`, (s) => `- \`${s}\``),
    positive('GitHub token de app (servidor)', 'github-token', `ghs_${fake(BASE62, 36, 52)}`, (s) => `GH_TOKEN="${s}"`),
    positive(
      'GitHub token de app (usuário)',
      'github-token',
      `ghu_${fake(BASE62, 36, 53)}`,
      (s) => `Authorization: token ${s}`,
    ),
    positive('GitHub refresh token', 'github-token', `ghr_${fake(BASE62, 36, 54)}`, (s) => `| refresh | ${s} |`),
    positive(
      'GitHub token granular',
      'github-token',
      `github_pat_${fake(BASE62, 22, 55)}_${fake(BASE62, 59, 56)}`,
      (s) => `O PAT novo é ${s}, válido por 90 dias.`,
    ),
    positive(
      'GitHub token como senha de URL',
      'github-token',
      `ghp_${fake(BASE62, 36, 57)}`,
      (s) => `git clone https://renan:${s}@github.com/lumen/atlas.git`,
    ),

    // GitLab, Slack, Stripe, Google, npm
    positive(
      'GitLab token pessoal',
      'gitlab-token',
      `glpat-${fake(BASE62, 20, 60)}`,
      (s) => `GITLAB_TOKEN=${s} # do runner`,
    ),
    positive(
      'Slack token de bot',
      'slack-token',
      `xoxb-${fake(DIGITS, 12, 61)}-${fake(DIGITS, 13, 62)}-${fake(BASE62, 24, 63)}`,
      (s) => `O bot do canal #atlas usa ${s}`,
    ),
    positive(
      'Slack token de usuário',
      'slack-token',
      `xoxp-${fake(DIGITS, 12, 64)}-${fake(DIGITS, 12, 65)}-${fake(DIGITS, 12, 66)}-${fake(HEX, 32, 67)}`,
      (s) => `slack: "${s}"`,
    ),
    positive(
      'Slack token de app',
      'slack-token',
      `xapp-1-A${fake(UPPER + DIGITS, 10, 68)}-${fake(DIGITS, 13, 69)}-${fake(HEX, 64, 70)}`,
      (s) => `SLACK_APP_TOKEN=${s}`,
    ),
    positive(
      'Stripe chave secreta',
      'stripe-key',
      `sk_live_${fake(BASE62, 24, 71)}`,
      (s) => `Stripe em produção: ${s}`,
    ),
    positive(
      'Stripe chave restrita',
      'stripe-key',
      `rk_live_${fake(BASE62, 99, 72)}`,
      (s) => `stripe.api_key = "${s}"`,
    ),
    positive(
      'Google API key',
      'google-api-key',
      `AIza${fake(BASE64URL, 35, 73)}`,
      (s) => `https://maps.googleapis.com/maps/api/geocode/json?key=${s}&address=x`,
    ),
    positive('npm token', 'npm-token', `npm_${fake(BASE62, 36, 74)}`, (s) => `//registry.npmjs.org/:_authToken=${s}`),

    // OpenAI e Anthropic
    positive('OpenAI chave antiga', 'openai-api-key', `sk-${fake(BASE62, 48, 80)}`, (s) => `OPENAI_API_KEY=${s}`),
    positive(
      'OpenAI chave de projeto',
      'openai-api-key',
      `sk-proj-${fake(BASE64URL, 120, 81)}`,
      (s) => `A chave da OpenAI é \`${s}\`.`,
    ),
    positive(
      'Anthropic chave de API',
      'anthropic-api-key',
      `sk-ant-api03-${fake(BASE64URL, 93, 82)}AA`,
      (s) => `ANTHROPIC_API_KEY: ${s}`,
    ),

    // JWT
    positive('JWT em cabeçalho HTTP', 'jwt', jwt, (s) => `Authorization: Bearer ${s}`),
    positive('JWT solto na prosa', 'jwt', jwt, (s) => `O serviço devolveu ${s} e depois caiu.`),
    positive(
      'confirm_token do forget copiado para uma nota',
      'cabecao-confirm-token',
      `${'cbc'}${'_ct_'}t3k9q2_${fake(BASE64URL, 43, 76)}`,
      (s) => `Próximo passo: chamar forget com confirm_token ${s} amanhã.`,
    ),
    positive(
      'confirm_token como atribuição',
      'cabecao-confirm-token',
      `${'cbc'}${'_ct_'}t3k9q3_${fake(BASE64URL, 43, 77)}`,
      (s) => `confirm_token: ${s}`,
    ),

    // URL com credencial: o achado é a senha.
    positive(
      'URL de banco com senha',
      'url-credentials',
      `${fake(LOWER, 6, 90)}${fake(DIGITS, 4, 91)}`,
      (s) => `DATABASE_URL=postgres://atlas:${s}@db.interno:5432/atlas`,
    ),
    positive(
      'URL https com senha',
      'url-credentials',
      `${fake(BASE62, 12, 92)}!`,
      (s) => `Baixe de https://deploy:${s}@artefatos.lumen.example/pacote.tgz`,
    ),
    positive('URL sem usuário', 'url-credentials', fake(BASE62, 20, 93), (s) => `redis://:${s}@cache.interno:6379/0`),
    positive(
      'URL de fila com senha curta',
      'url-credentials',
      `fila${fake(DIGITS, 3, 94)}`,
      (s) => `amqp://atlas:${s}@rabbit.interno/vhost`,
    ),

    // Atribuições genéricas: o achado é o valor.
    positive(
      'password= com senha humana',
      'generic-assignment',
      `Tr${fake(DIGITS, 1, 100)}ub${fake(DIGITS, 1, 101)}dor&${fake(DIGITS, 2, 102)}`,
      (s) => `password=${s}`,
    ),
    positive('senha: entre aspas', 'generic-assignment', `Lumen${fake(DIGITS, 4, 103)}!`, (s) => `senha: "${s}"`),
    positive(
      'DB_PASSWORD em .env',
      'generic-assignment',
      fake(BASE62, 16, 104),
      (s) => `DB_HOST=db.interno\nDB_PASSWORD='${s}'\nDB_PORT=5432`,
    ),
    positive(
      'Senha em negrito de Markdown',
      'generic-assignment',
      `atlas${fake(DIGITS, 5, 105)}`,
      (s) => `- **Senha**: ${s}`,
    ),
    positive(
      'senha no fim da frase',
      'generic-assignment',
      `Verao${fake(DIGITS, 4, 106)}`,
      (s) => `O acesso do painel: usuário ana, senha: ${s}.`,
    ),
    positive('api_key com hex', 'generic-assignment', fake(HEX, 32, 107), (s) => `api_key: ${s}`),
    positive(
      'clientSecret em JSON',
      'generic-assignment',
      fake(BASE62, 40, 108),
      (s) => `{ "clientSecret": "${s}", "clientId": "atlas-web" }`,
    ),
    positive('token = com base64', 'generic-assignment', `${fake(BASE64, 43, 109)}=`, (s) => `token = ${s}`),
    positive('export de API_TOKEN', 'generic-assignment', fake(BASE64URL, 32, 110), (s) => `export API_TOKEN=${s}`),
    positive('secret= com hex de 64', 'generic-assignment', fake(HEX, 64, 111), (s) => `WEBHOOK_SECRET=${s}`),
    positive('apiKey em código', 'generic-assignment', fake(BASE62, 32, 112), (s) => `const apiKey = '${s}';`),
    positive(
      'access_key em YAML',
      'generic-assignment',
      fake(BASE62, 24, 113),
      (s) => `---\ntype: fact\naccess_key: ${s}\n---\n`,
    ),
    positive(
      'token em código inline',
      'generic-assignment',
      fake(BASE62, 28, 114),
      (s) => `Rodei com \`--token=${s}\` e funcionou.`,
    ),
    positive('private_key em hex', 'generic-assignment', fake(HEX, 64, 115), (s) => `private_key => "${s}"`),
  ];
}

export function buildNegatives(): NegativeCase[] {
  const ulid = `01${fake(CROCKFORD, 24, 200)}`;
  const sha1 = fake(HEX, 40, 201);
  const sha256 = fake(HEX, 64, 202);
  const uuid = [8, 4, 4, 4, 12].map((n, i) => fake(HEX, n, 203 + i)).join('-');
  const blob = fake(BASE64, 240, 210);
  // Separado para o texto de teste poder conter "${" sem virar interpolação.
  const DOLLAR = '$';
  const cases: [string, string][] = [
    // Identificadores e hashes legítimos
    ['ULID solto', `A nota ${ulid} foi criada ontem.`],
    ['ULID no frontmatter', `---\nid: ${ulid}\ntype: fact\n---\n`],
    ['ULID como token de sessão', `session_token: ${ulid}`],
    ['SHA de commit', `Corrigido no commit ${sha1} (abreviado: ${sha1.slice(0, 7)}).`],
    ['SHA-256 com prefixo', `sha256:${sha256}`],
    ['checksum de arquivo', `checksum: ${sha256}  atlas-1.4.0.tgz`],
    ['chunkKey em hex', `{"chunkKey": "${fake(HEX, 32, 211)}", "model": "e5-small"}`],
    ['content_hash em hex', `content_hash: ${sha256}`],
    ['key genérica com hash', `key: ${sha1}`],
    ['UUID', `Pedido ${uuid} ficou preso na fila.`],
    ['UUID como token', `token: ${uuid}`],
    ['base64 de exemplo', `O corpo em base64 fica assim:\n\n${blob}==\n`],
    ['imagem em data URI', `![logo](data:image/png;base64,iVBORw0KGgo${blob})`],
    ['integrity de pacote', `integrity: sha512-${fake(BASE64, 86, 212)}==`],
    ['fingerprint de chave SSH', `SHA256:${fake(BASE64, 43, 213)} ana@notebook`],
    ['chave pública SSH', `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA${fake(BASE64, 43, 214)} ana@notebook`],
    ['certificado (não é chave privada)', `${BEGIN}CERTIFICATE${'-'.repeat(5)}\n${base64Lines(215)}\n`],
    ['chave pública PEM', `${BEGIN}PUBLIC KEY${'-'.repeat(5)}\n${base64Lines(219)}\n`],
    ['trailer de commit', `Cabecao-Session: ${ulid}\nCabecao-Machine: notebook-do-renan`],
    ['hash em tabela', `| arquivo | sha256 |\n|---|---|\n| a.md | ${sha256} |`],

    // Placeholders óbvios
    ['ghp_ com xxxx', `export GITHUB_TOKEN=ghp_${'x'.repeat(36)}`],
    ['<seu-token>', 'token=<seu-token>'],
    ['token entre sinais', 'Authorization: Bearer <TOKEN>'],
    ['AWS de exemplo', `aws_access_key_id = AKIA${'IOSFODNN7'}EXAMPLE`],
    ['AWS secret de exemplo', `aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCY${'EXAMPLE'}KEY`],
    ['changeme', 'password=changeme'],
    ['changeme com dígitos', 'DB_PASSWORD=changeme123'],
    ['reticências', 'api_key: ...'],
    ['sk- com reticências', 'OPENAI_API_KEY=sk-...'],
    ['sk-ant- com reticências', 'ANTHROPIC_API_KEY=sk-ant-...'],
    ['your_api_key_here', 'API_KEY=your_api_key_here_1234567890'],
    ['asteriscos', 'senha: ************'],
    ['URL com senha de exemplo', 'Formato: https://user:senha@host/caminho'],
    ['URL com senha entre sinais', 'postgres://usuario:<senha>@host:5432/banco'],
    ['URL com senha trivial', 'DATABASE_URL=postgres://postgres:postgres@localhost:5432/atlas_dev'],
    ['URL de documentação com senha de 3 letras', "const myURL = new URL('https://abc:xyz@example.com');"],
    ['URL com variável', 'https://deploy:$DEPLOY_TOKEN@artefatos.exemplo.com/'],
    ['variável de ambiente', `password: ${DOLLAR}{DB_PASSWORD}`],
    ['variável de shell', 'token: $GITHUB_TOKEN_2026'],
    ['leitura de ambiente em Python', 'api_key = os.environ["OPENAI_API_KEY_V2"]'],
    ['leitura de ambiente em Node', 'const secret = process.env.SESSION_SECRET_V2;'],
    ['template', 'password: {{ vault_db_password_2026 }}'],
    ['segredo do GitHub Actions', `token: ${DOLLAR}{{ secrets.NPM_TOKEN_2026 }}`],
    ['JWT com reticências', 'Authorization: Bearer eyJhbGciOi...'],
    ['PEM só o cabeçalho, na prosa', `O scanner procura por "${pemHeader('RSA ')}" no texto.`],
    ['PEM com reticências', `${pemHeader('')}\n...\n${pemFooter('')}`],
    ['token de exemplo', `token: EXAMPLE${fake(BASE62, 24, 220)}`],

    // Prosa e configuração comuns
    ['regra de senha', 'A senha: deve ter pelo menos 12 caracteres, com letras e dígitos.'],
    ['explicação de token', 'O token: é renovado a cada 30 dias pelo servidor de autenticação.'],
    ['orçamento de tokens', 'tokens: 3500\nmax_tokens=4096\ntoken_budget: 20000'],
    ['URL de token', 'token_url: https://auth.exemplo.com/oauth2/v2token/emitir'],
    ['nome de segredo', 'secret_name: atlas-prod-db-credentials-v2'],
    ['slug com data', 'token: 2026-11-10-atlas-consumidores'],
    ['palavra que contém senha', 'desenhar: diagrama2026completo-da-arquitetura'],
    ['arquivo de senha', 'password_file: /run/secrets/db_password_v2'],
    ['algoritmo de token', 'token_type: Bearer\ntoken_algorithm: HS256-com-rotacao2026'],
    ['remoto SSH', 'git remote add origin git@github.com:lumen/atlas.git'],
    ['URL com porta e arroba na query', 'https://exemplo.com:8443/caminho?contato=ana@lumen.example'],
    ['e-mail', 'Fale com ana.prado@lumen.example ou bruno@lumen.example.'],
    ['wikilink', 'Ver [[Projeto Atlas]] e [[usar-sqs-para-filas|a decisão]].'],
    ['data e hora', 'created: 2026-11-10T14:03:22-03:00'],
    ['slug que começa com sk-', 'Ver a nota sk-nao-e-uma-chave-apenas-um-slug-bem-longo.'],
    ['prefixos citados na prosa', 'Formatos: ghp_, gho_, glpat-, xoxb-, sk_live_, AIza, sk-ant-, npm_, AKIA, eyJ.'],
    ['variável npm', 'npm_config_registry=https://registry.npmjs.org/'],
    ['nome de pacote', 'pnpm add @scope/pacote-de-tokens@12.4.1'],
    ['versão e build', 'secret-scanner: v1.2.3-beta.4+build20261110'],
    ['senha só de letras', 'senha: abacaxi-com-hortelã'],
    ['comparação em código', 'if (password === storedPassword2) return true;'],
    ['tipo em código', 'password: string | undefined;\ntoken: Promise<string>;'],
    ['chamada de função', 'const token = await fetchToken2026(clientId);'],
    ['caminho de nota', 'token: wiki/decisions/usar-sqs-para-filas-2026'],
    ['frase longa com dois-pontos', 'Segredo: nunca commitar o arquivo .env2 do projeto.'],
    ['modelo de embeddings', 'model: multilingual-e5-small\ndims: 384\nquantization: int8'],
  ];
  return cases.map(([name, text]) => ({ name, text }));
}
