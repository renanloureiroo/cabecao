import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    pool: 'forks',
    // Muitos testes criam repositórios git e processos filhos. Nos runners do Windows, 5 s não bastam quando a
    // suíte inteira roda em paralelo; um travamento de verdade ainda aparece, como erro das novas tentativas.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
