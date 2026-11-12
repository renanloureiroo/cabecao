import { expect, it } from 'vitest';
import { unsupportedNodeMessage } from '../src/node-version.ts';

it.each(['22.16.0', '22.23.4', 'v22.16.0', '24.0.0', '24.21.0', '25.0.0', '26.13.1', '27.0.0-nightly'])(
  'aceita Node %s',
  (version) => {
    expect(unsupportedNodeMessage(version)).toBeUndefined();
  },
);

it.each(['12.22.0', '18.20.0', '20.19.0', '22.5.0', '22.15.1', '23.0.0', '23.11.1'])('recusa Node %s', (version) => {
  const message = unsupportedNodeMessage(version);
  expect(message).toContain('cabecao precisa de Node.js 22.16+ ou 24+');
  expect(message).toContain(`Versão atual: v${version}`);
});

it('não repete o "v" quando a versão já vem com ele', () => {
  expect(unsupportedNodeMessage('v20.1.0')).toContain('Versão atual: v20.1.0.');
});
