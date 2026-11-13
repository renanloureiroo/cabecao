// Site de documentação do Cabeção. Publicado no GitHub Pages pelo workflow .github/workflows/docs.yml.
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';

const REPO = 'https://github.com/renanloureiroo/cabecao';

export default defineConfig({
  site: 'https://renanloureiroo.github.io',
  base: '/cabecao',
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'Cabeção',
      description: 'Seu segundo cérebro em Markdown e git, para você e seus agentes de IA, servido por MCP.',
      logo: {
        light: './src/assets/logo-light.svg',
        dark: './src/assets/logo-dark.svg',
        alt: 'Cabeção',
      },
      favicon: '/favicon.svg',
      defaultLocale: 'root',
      locales: {
        root: { label: 'Português', lang: 'pt-BR' },
        en: { label: 'English', lang: 'en' },
      },
      social: [{ icon: 'github', label: 'GitHub', href: REPO }],
      editLink: { baseUrl: `${REPO}/edit/main/website/` },
      lastUpdated: false,
      customCss: [
        '@fontsource-variable/atkinson-hyperlegible-next',
        '@fontsource-variable/atkinson-hyperlegible-mono',
        './src/styles/theme.css',
      ],
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://renanloureiroo.github.io/cabecao/og.png' } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1280' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '640' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
      ],
      expressiveCode: {
        themes: ['github-dark-default', 'github-light-default'],
      },
      plugins: [starlightLinksValidator({ errorOnRelativeLinks: true, errorOnInvalidHashes: true })],
      sidebar: [
        {
          label: 'Começar',
          translations: { en: 'Get started' },
          items: [{ autogenerate: { directory: 'comecar' } }],
        },
        {
          label: 'Conceitos',
          translations: { en: 'Concepts' },
          items: [{ autogenerate: { directory: 'conceitos' } }],
        },
        {
          label: 'Guias',
          translations: { en: 'Guides' },
          items: [{ autogenerate: { directory: 'guias' } }],
        },
        {
          label: 'Referência',
          translations: { en: 'Reference' },
          items: [{ autogenerate: { directory: 'referencia' } }],
        },
        {
          label: 'Mais',
          translations: { en: 'More' },
          items: ['seguranca', 'problemas', 'em-breve', 'faq', 'novidades'],
        },
      ],
    }),
  ],
});
