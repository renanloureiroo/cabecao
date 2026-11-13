// Site de documentação do Cabeção. Publicado no GitHub Pages pelo workflow .github/workflows/docs.yml.
import type * as Preset from '@docusaurus/preset-classic';
import type { Config } from '@docusaurus/types';
import type { PrismTheme } from 'prism-react-renderer';

const REPO = 'https://github.com/renanloureiroo/cabecao';
const BASE = '/cabecao/';

// Bloco de código sempre escuro, com as quatro cores code.* do design system (tokens.css).
const codeTheme: PrismTheme = {
  plain: { color: 'var(--code-text)', backgroundColor: 'var(--code-bg)' },
  styles: [
    {
      types: ['comment', 'prolog', 'doctype', 'cdata', 'shebang'],
      style: { color: 'var(--code-comment)', fontStyle: 'italic' },
    },
    {
      types: ['keyword', 'builtin', 'boolean', 'important', 'atrule', 'function', 'deleted'],
      style: { color: 'var(--code-keyword)' },
    },
    {
      types: ['string', 'char', 'number', 'attr-value', 'url', 'regex', 'inserted', 'constant'],
      style: { color: 'var(--code-string)' },
    },
    {
      types: ['punctuation', 'operator', 'property', 'variable', 'tag', 'attr-name', 'selector', 'class-name'],
      style: { color: 'var(--code-text)' },
    },
  ],
};

// As fontes do design system ficam no próprio site (static/fonts), com pré-carga e font-display: swap.
const FONTS = [
  { family: 'Bricolage Grotesque', file: 'bricolage-grotesque.woff2', weight: '200 800' },
  { family: 'JetBrains Mono', file: 'jetbrains-mono.woff2', weight: '100 800' },
];

const config: Config = {
  title: 'Cabeção',
  tagline: 'Seu segundo cérebro em Markdown e git, para você e seus agentes de IA, servido por MCP.',
  favicon: 'img/favicon.svg',

  url: 'https://renanloureiroo.github.io',
  baseUrl: BASE,
  trailingSlash: true,
  organizationName: 'renanloureiroo',
  projectName: 'cabecao',

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',
  onDuplicateRoutes: 'throw',

  headTags: [
    ...FONTS.map((f) => ({
      tagName: 'link',
      attributes: {
        rel: 'preload',
        href: `${BASE}fonts/${f.file}`,
        as: 'font',
        type: 'font/woff2',
        crossorigin: 'anonymous',
      },
    })),
    {
      tagName: 'style',
      attributes: {},
      innerHTML: FONTS.map(
        (f) =>
          `@font-face{font-family:"${f.family}";src:url("${BASE}fonts/${f.file}") format("woff2");font-weight:${f.weight};font-style:normal;font-display:swap}`,
      ).join(''),
    },
    {
      tagName: 'link',
      attributes: { rel: 'icon', type: 'image/png', sizes: '32x32', href: `${BASE}img/favicon-32.png` },
    },
    { tagName: 'link', attributes: { rel: 'apple-touch-icon', href: `${BASE}img/apple-touch-icon.png` } },
    { tagName: 'meta', attributes: { name: 'theme-color', content: '#14121c' } },
  ],

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
          customCss: ['./src/css/tokens.css', './src/css/custom.css'],
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
    image: 'img/cartao-social.png',
    colorMode: { respectPrefersColorScheme: true },
    navbar: {
      title: 'Cabeção',
      logo: { alt: '', src: 'img/simbolo-escuro.svg', srcDark: 'img/simbolo-claro.svg', width: 32, height: 32 },
      items: [
        { type: 'doc', docId: 'comecar/instalacao', position: 'left', label: 'Começar' },
        { type: 'doc', docId: 'referencia/cli', position: 'left', label: 'Referência' },
        { type: 'doc', docId: 'novidades', position: 'left', label: 'Novidades' },
        { type: 'search', position: 'right' },
        { type: 'localeDropdown', position: 'right' },
        { href: REPO, position: 'right', label: 'GitHub' },
      ],
    },
    footer: {
      style: 'light',
      logo: {
        alt: 'Cabeção: segundo cérebro · markdown + git + mcp',
        src: 'img/assinatura-site-claro.svg',
        srcDark: 'img/assinatura-site-escuro.svg',
        href: '/',
        width: 349,
        height: 60,
      },
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
      copyright: 'Um projeto de Renan Loureiro. Software livre, sob a licença MIT.',
    },
    prism: {
      theme: codeTheme,
      darkTheme: codeTheme,
      additionalLanguages: ['bash', 'json', 'yaml', 'toml'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
