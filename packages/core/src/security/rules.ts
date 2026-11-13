// Regras do scanner de segredos.
//
// Cuidados comuns a todas as expressões regulares deste arquivo:
// - começam por um literal (prefixo ou palavra-chave) e usam só classes de caracteres com
//   quantificadores limitados ou seguidos da negação da própria classe, sem grupos repetidos
//   aninhados: o custo é linear no tamanho do texto, sem retrocesso catastrófico;
// - nenhuma atravessa quebra de linha (a chave privada é conferida à parte, numa janela fixa);
// - a ordem da lista é a prioridade: quando dois achados se sobrepõem, fica o da regra que vem antes.
import { isPlaceholder, longestMixedRun, looksLikeGeneratedSecret, looksLikePassword } from './heuristics.ts';

export const SECRET_RULE_IDS = [
  'private-key',
  'aws-access-key-id',
  'aws-secret-access-key',
  'github-token',
  'gitlab-token',
  'slack-token',
  'stripe-key',
  'google-api-key',
  'anthropic-api-key',
  'openai-api-key',
  'npm-token',
  'jwt',
  'url-credentials',
  'generic-assignment',
] as const;

export type SecretRuleId = (typeof SECRET_RULE_IDS)[number];

/** O que uma regra devolve ao aceitar uma ocorrência: onde está o segredo e, se quiser, como exibi-lo. */
export interface RuleHit {
  /** Posição do primeiro caractere do segredo no texto. */
  start: number;
  /** Posição logo após o último caractere do segredo. */
  end: number;
  /** Texto já seguro para exibir. Sem isso, o scanner redige `text.slice(start, end)`. */
  display?: string;
}

export interface SecretRule {
  id: SecretRuleId;
  description: string;
  /** Sempre com as flags `g` (varredura) e `d` (posição dos grupos). */
  pattern: RegExp;
  /** Confere a ocorrência e diz onde está o segredo; `undefined` descarta. */
  locate: (match: RegExpExecArray, text: string) => RuleHit | undefined;
}

function groupSpan(match: RegExpExecArray, group: number): RuleHit | undefined {
  const span = match.indices?.[group];
  return span ? { start: span[0], end: span[1] } : undefined;
}

/** Regra de formato conhecido: o segredo é a ocorrência inteira, salvo placeholder. */
function wholeMatch(match: RegExpExecArray): RuleHit | undefined {
  return isPlaceholder(match[0]) ? undefined : groupSpan(match, 0);
}

/** Regra em que o segredo é um grupo de captura, salvo placeholder. */
function captured(group: number): SecretRule['locate'] {
  return (match) => (isPlaceholder(match[group] ?? '') ? undefined : groupSpan(match, group));
}

// --- Chave privada -------------------------------------------------------------------------------

const PEM_WINDOW = 400;
const PEM_HEADER_LINE = /^[A-Za-z-]+:\s/;
const PEM_BODY = /^[A-Za-z0-9+/=]{24,}/;

/**
 * O cabeçalho sozinho aparece em documentação; só vale como achado se vier seguido de material de
 * chave em base64. Aceita o bloco com quebras reais ou com `\n` escrito (chave dentro de JSON).
 */
function locatePrivateKey(match: RegExpExecArray, text: string): RuleHit | undefined {
  const start = match.index;
  const end = start + match[0].length;
  const body = text
    .slice(end, end + PEM_WINDOW)
    .replace(/\\[rn]/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^[\s>|"']+/, '').trimEnd())
    .filter((line) => line !== '' && !PEM_HEADER_LINE.test(line))
    .join('');
  if (!PEM_BODY.test(body)) return undefined;
  return { start, end, display: match[0] };
}

// --- URL com credencial --------------------------------------------------------------------------

// Senhas que só aparecem em exemplo ou em ambiente local de desenvolvimento.
const TRIVIAL_PASSWORDS = new Set([
  'password',
  'passwd',
  'pass',
  'pwd',
  'senha',
  'secret',
  'segredo',
  'token',
  'admin',
  'root',
  'guest',
  'user',
  'usuario',
  'postgres',
  'mysql',
  'redis',
  'mongo',
  'test',
  'teste',
]);

function locateUrlPassword(match: RegExpExecArray): RuleHit | undefined {
  const password = match[2] ?? '';
  if (TRIVIAL_PASSWORDS.has(password.toLowerCase())) return undefined;
  if (/^[$%{[]/.test(password) || isPlaceholder(password)) return undefined;
  return groupSpan(match, 2);
}

// --- Atribuição genérica -------------------------------------------------------------------------

const PASSWORD_KEYWORD = /^(?:pass|pwd|senha)/i;

// Finais de nome que indicam metadado sobre o segredo, não o segredo: `token_url`, `secret_name`, `tokenTtl`.
const NON_SECRET_SUFFIX =
  /(?:name|id|ids|path|file|dir|url|uri|endpoint|type|kind|length|len|size|ttl|expiry|expires|expiration|count|limit|limits|version|field|header|prefix|suffix|format|algorithm|alg|policy|scanner|budget|usage)$/i;

const isLower = (char: string) => char >= 'a' && char <= 'z';
const isUpper = (char: string) => char >= 'A' && char <= 'Z';
const sameCaseLetters = (a: string, b: string) => (isLower(a) && isLower(b)) || (isUpper(a) && isUpper(b));

function locateAssignment(match: RegExpExecArray, text: string): RuleHit | undefined {
  const keyword = match[1] ?? '';
  const suffix = match[2] ?? '';
  const span = match.indices?.[3];
  if (!span) return undefined;

  // A palavra-chave tem de ser uma palavra inteira ou um pedaço de camelCase/snake_case:
  // descarta "desenhar" (contém "senha"), "tokens", "tokenizer", "secretaria".
  const before = match.index > 0 ? text.charAt(match.index - 1) : '';
  if (isLower(keyword.charAt(0)) && (isLower(before) || isUpper(before))) return undefined;
  if (sameCaseLetters(keyword.charAt(keyword.length - 1), suffix.charAt(0))) return undefined;
  if (NON_SECRET_SUFFIX.test(suffix)) return undefined;

  // Pontuação de fim de frase e ênfase de Markdown não fazem parte do valor.
  const value = (match[3] ?? '').replace(/[,;.:!?*_)\]}]+$/, '');
  const accepted = PASSWORD_KEYWORD.test(keyword) ? looksLikePassword(value) : looksLikeGeneratedSecret(value);
  if (!accepted) return undefined;

  const start = span[0];
  const end = start + value.length;
  return { start, end };
}

// --- Lista de regras -----------------------------------------------------------------------------

export const SECRET_RULES: readonly SecretRule[] = [
  {
    id: 'private-key',
    description:
      'Chave privada em PEM ou OpenSSH (RSA, EC, DSA, OPENSSH, PGP, PKCS#8, cifrada ou não): cabeçalho "BEGIN ... PRIVATE KEY" seguido de material em base64.',
    pattern: /-----BEGIN (?:[A-Z0-9]{1,12} ){0,3}PRIVATE KEY(?: BLOCK)?-----/dg,
    locate: locatePrivateKey,
  },
  {
    id: 'aws-access-key-id',
    description: 'Identificador de chave de acesso da AWS: AKIA (permanente) ou ASIA (temporária) + 16 caracteres.',
    pattern: /(?<![A-Za-z0-9])A[KS]IA[A-Z0-9]{16}(?![A-Za-z0-9])/dg,
    locate: wholeMatch,
  },
  {
    id: 'aws-secret-access-key',
    description:
      'Chave secreta da AWS: 40 caracteres em base64 atribuídos a um nome como aws_secret_access_key ou SecretAccessKey.',
    pattern:
      /secret[_-]?(?:access[_-]?)?key["'`]?[ \t]{0,4}(?::=|=>|:|=)[ \t]{0,4}["'`]?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/dgi,
    locate: captured(1),
  },
  {
    id: 'github-token',
    description:
      'Token do GitHub: ghp_ (pessoal), gho_ (OAuth), ghu_/ghs_ (app), ghr_ (refresh) + 36 ou mais caracteres, ou github_pat_ (granular).',
    pattern: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{36,255})(?![A-Za-z0-9_])/dg,
    locate: wholeMatch,
  },
  {
    id: 'gitlab-token',
    description: 'Token de acesso pessoal do GitLab: glpat- + 20 ou mais caracteres.',
    pattern: /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,255}(?![A-Za-z0-9_-])/dg,
    locate: wholeMatch,
  },
  {
    id: 'slack-token',
    description: 'Token do Slack: xoxb-, xoxp-, xoxa-, xoxe-, xoxo-, xoxr-, xoxs- ou xapp- seguido do corpo do token.',
    pattern: /(?<![A-Za-z0-9_-])(?:xox[abeoprs]|xapp)-[A-Za-z0-9-]{10,255}(?![A-Za-z0-9-])/dg,
    locate: wholeMatch,
  },
  {
    id: 'stripe-key',
    description: 'Chave de produção do Stripe: sk_live_ (secreta) ou rk_live_ (restrita) + 16 ou mais caracteres.',
    pattern: /(?<![A-Za-z0-9_])[sr]k_live_[A-Za-z0-9]{16,255}(?![A-Za-z0-9_])/dg,
    locate: wholeMatch,
  },
  {
    id: 'google-api-key',
    description: 'Chave de API do Google: AIza + 35 caracteres.',
    pattern: /(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/dg,
    locate: wholeMatch,
  },
  {
    id: 'anthropic-api-key',
    description: 'Chave de API da Anthropic: sk-ant- + 24 ou mais caracteres.',
    pattern: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{24,255}(?![A-Za-z0-9_-])/dg,
    locate: wholeMatch,
  },
  {
    id: 'openai-api-key',
    description:
      'Chave de API da OpenAI e de serviços no mesmo formato: sk- (ou sk-proj-, sk-svcacct-, sk-admin-) + 20 ou mais caracteres com letras e dígitos misturados.',
    pattern: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,255}(?![A-Za-z0-9_-])/dg,
    // "sk-" é curto demais para bastar: exige corpo com cara de gerado, para não acusar um slug.
    locate: (match) => (longestMixedRun(match[0]) >= 8 ? wholeMatch(match) : undefined),
  },
  {
    id: 'npm-token',
    description: 'Token de acesso do npm: npm_ + 36 caracteres.',
    pattern: /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/dg,
    locate: wholeMatch,
  },
  {
    id: 'jwt',
    description:
      'JSON Web Token assinado: três partes em base64url separadas por ponto, as duas primeiras começando por eyJ.',
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}/dg,
    locate: wholeMatch,
  },
  {
    id: 'url-credentials',
    description:
      'URL com senha embutida (esquema://usuario:senha@host). Senhas de exemplo, triviais (senha, password, postgres...) ou com menos de 4 caracteres são ignoradas.',
    pattern: /:\/\/([^\s/:@"'`<>]{0,128}):([^\s/@"'`<>]{4,256})@(?=[A-Za-z0-9[])/dg,
    locate: locateUrlPassword,
  },
  {
    id: 'generic-assignment',
    description:
      'Atribuição a um nome sensível (password, senha, secret, token, api_key, access_key, private_key, credential) cujo valor tem cara de segredo: senha com letras e dígitos, ou valor longo de alta entropia.',
    pattern:
      /(pass(?:word|wd|phrase)|pwd|senha|secret|segredo|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)([A-Za-z0-9_.-]{0,24})["'`*\]]{0,3}[ \t]{0,4}(?::=|=>|:|=)[ \t]{0,4}["'`]?([^\s"'`<>]{8,512})/dgi,
    locate: locateAssignment,
  },
];
