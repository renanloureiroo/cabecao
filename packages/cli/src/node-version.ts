// Este arquivo vai para dentro do bin e roda em qualquer Node, inclusive nos antigos.
// Não importe nada aqui e use só sintaxe que versões antigas entendem.

/**
 * Devolve a mensagem de erro quando a versão do Node não é aceita, ou `undefined` quando é.
 * A faixa aceita é `^22.16.0 || >=24.0.0`: o `node:sqlite` só tem FTS5 a partir da 22.16, e a linha 23 não tem.
 */
export function unsupportedNodeMessage(version: string): string | undefined {
  const parts = version.replace(/^v/, '').split('.');
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  const supported = major === 22 ? minor >= 16 : major >= 24;
  if (supported) return undefined;
  return `cabecao precisa de Node.js 22.16+ ou 24+. Versão atual: v${version.replace(/^v/, '')}. Atualize em https://nodejs.org`;
}
