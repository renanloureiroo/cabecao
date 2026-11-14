// Este arquivo vai para dentro do bin e roda em qualquer Node, inclusive nos antigos.
// Não importe nada aqui e use só sintaxe que versões antigas entendem.

/**
 * Devolve a mensagem de erro quando a versão do Node não é aceita, ou `undefined` quando é.
 * A faixa aceita é `^22.16.0 || >=24.0.0`, dita ao usuário como "22.16 ou mais novo": o `node:sqlite` só tem FTS5 a
 * partir da 22.16, e a linha 23 (já fora de suporte) não tem.
 */
export function unsupportedNodeMessage(version: string): string | undefined {
  const parts = version.replace(/^v/, '').split('.');
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  const supported = major === 22 ? minor >= 16 : major >= 24;
  if (supported) return undefined;
  // a 23 é mais nova que a 22.16 e mesmo assim não serve: a mensagem diz, para não parecer engano
  const odd = major === 23 ? ' A linha 23 não serve (falta a busca de texto do SQLite): use a 24.' : '';
  return (
    'cabecao precisa de Node.js 22.16 ou mais novo.' +
    odd +
    ' Versão atual: v' +
    version.replace(/^v/, '') +
    '. Atualize em https://nodejs.org'
  );
}
