// Site de documentação do Cabeção. Publicado no GitHub Pages pelo workflow .github/workflows/docs.yml.
import type * as Preset from '@docusaurus/preset-classic';
import type { Config } from '@docusaurus/types';
import { themes as prismThemes } from 'prism-react-renderer';

const REPO = 'https://github.com/renanloureiroo/cabecao';

const config: Config = {
  title: 'Cabeção',
  tagline: 'Seu segundo cérebro em Markdown e git, para você e seus agentes de IA, servido por MCP.',
  favicon: 'img/favicon.svg',

  url: 'https://renanloureiroo.github.io',
  baseUrl: '/cabecao/',
  trailingSlash: true,
  organizationName: 'renanloureiroo',
  projectName: 'cabecao',

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',
  onDuplicateRoutes: 'throw',

  markdown: {
    // .md é CommonMark (as saídas reais da CLI têm < e { soltos); .mdx só onde há componentes.
    format: 'detect',
    hooks: { onBrokenMarkdownLinks: 'throw', onBrokenMarkdownImages: 'throw' },
  },

  i18n: {
    defaultLocale: 'pt-BR',
    locales: ['pt-BR', 'en'],
    localeConfigs: {
      'pt-BR': { label: 'Português', htmlLang: 'pt-BR' },
      en: { label: 'English', htmlLang: 'en' },
    },
  },

  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          editUrl: `${REPO}/edit/main/docs/`,
          showLastUpdateTime: false,
        },
        blog: false,
        theme: {
          customCss: [
            require.resolve('@fontsource-variable/atkinson-hyperlegible-next/index.css'),
            require.resolve('@fontsource-variable/atkinson-hyperlegible-mono/index.css'),
            './src/css/custom.css',
          ],
        },
      } satisfies Preset.Options,
    ],
  ],

  themes: [
    [
      // Busca local: o índice é montado no build e fica no próprio site, sem serviço externo.
      require.resolve('@easyops-cn/docusaurus-search-local'),
      {
        hashed: true,
        language: ['pt', 'en'],
        indexBlog: false,
        docsRouteBasePath: '/',
        highlightSearchTermsOnTargetPage: true,
        explicitSearchResultPath: true,
      },
    ],
  ],

  themeConfig: {
    image: 'img/og.png',
    colorMode: { respectPrefersColorScheme: true },
    navbar: {
      title: 'Cabeção',
      logo: { alt: 'Cabeção', src: 'img/logo-light.svg', srcDark: 'img/logo-dark.svg' },
      items: [
        { type: 'doc', docId: 'comecar/instalacao', position: 'left', label: 'Começar' },
        { type: 'doc', docId: 'referencia/cli', position: 'left', label: 'Referência' },
        { type: 'doc', docId: 'novidades', position: 'left', label: 'Novidades' },
        { type: 'localeDropdown', position: 'right' },
        { href: REPO, position: 'right', label: 'GitHub' },
      ],
    },
    footer: {
      style: 'light',
      links: [
        {
          title: 'Documentação',
          items: [
            { label: 'Instalação', to: '/comecar/instalacao/' },
            { label: 'Referência da CLI', to: '/referencia/cli/' },
            { label: 'Servidor MCP', to: '/referencia/mcp/' },
          ],
        },
        {
          title: 'Projeto',
          items: [
            { label: 'GitHub', href: REPO },
            { label: 'npm', href: 'https://www.npmjs.com/package/cabecao' },
            { label: 'Issues', href: `${REPO}/issues` },
          ],
        },
      ],
      copyright: 'Cabeção é software livre, sob a licença MIT.',
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.vsDark,
      additionalLanguages: ['bash', 'json', 'yaml', 'toml'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
