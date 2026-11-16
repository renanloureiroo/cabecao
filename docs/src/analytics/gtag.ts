// Google Analytics 4 no site de documentação.
// O gtag.js só é baixado depois do consentimento (banner ou página /privacidade/). Antes disso, e para
// quem recusa, nenhuma requisição vai para o Google. Sem GA_MEASUREMENT_ID no build, este módulo não faz nada.
// Os sinais de anúncio ficam sempre negados: o site não usa o GA para publicidade.
import ExecutionEnvironment from '@docusaurus/ExecutionEnvironment';
import type { ClientModule } from '@docusaurus/types';
import siteConfig from '@generated/docusaurus.config';
import { type Consent, getConsent, onConsentChange } from './consent';

type Params = Record<string, string | number | boolean | undefined>;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

const rawId = siteConfig.customFields?.gaMeasurementId;
export const MEASUREMENT_ID = typeof rawId === 'string' && /^G-[A-Z0-9]+$/.test(rawId) ? rawId : undefined;
const DEBUG = siteConfig.customFields?.gaDebug === true;

// Parâmetro que a busca local acrescenta ao abrir um resultado; vira evento e sai da URL medida.
const HIGHLIGHT_PARAM = '_highlight';
const SEARCH_DEBOUNCE_MS = 1500;
const MAX_TERM_LENGTH = 100;
const TITLE_WAIT_MS = 1000;

let loaded = false;
// A página atual e a anterior a ela (o referrer dentro do site, já que a navegação é SPA).
let currentPageUrl: string | undefined;
let currentReferrer: string | undefined;

function load(): void {
  if (loaded || !MEASUREMENT_ID) return;
  loaded = true;
  window.dataLayer = window.dataLayer || [];
  // O gtag espera o objeto arguments, não um array.
  window.gtag = function gtag() {
    // biome-ignore lint/complexity/noArguments: formato exigido pelo gtag.js
    window.dataLayer?.push(arguments);
  };
  window.gtag('consent', 'default', {
    analytics_storage: 'granted',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
  });
  window.gtag('js', new Date());
  window.gtag('config', MEASUREMENT_ID, {
    // As visualizações de página são enviadas por este módulo a cada navegação (ver onRouteDidUpdate).
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    ...(DEBUG ? { debug_mode: true } : {}),
  });
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
  document.head.appendChild(script);
}

// Quem retira o consentimento: o GA para de receber e os cookies dele são apagados.
function revoke(): void {
  window.gtag?.('consent', 'update', { analytics_storage: 'denied' });
  const host = window.location.hostname;
  for (const cookie of document.cookie.split(';')) {
    const name = cookie.split('=')[0]?.trim();
    if (!name || !(name === '_ga' || name.startsWith('_ga_') || name === '_gid')) continue;
    for (const domain of ['', `; domain=${host}`, `; domain=.${host}`]) {
      // biome-ignore lint/suspicious/noDocumentCookie: a Cookie Store API ainda não existe em todos os navegadores
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domain}`;
    }
  }
}

function enabled(): boolean {
  return loaded && getConsent() === 'granted' && typeof window.gtag === 'function';
}

/** Envia um evento ao GA4, se houver consentimento. Sem consentimento, não faz nada. */
export function track(name: string, params: Params = {}): void {
  if (!enabled()) return;
  window.gtag?.('event', name, {
    site_locale: document.documentElement.lang || undefined,
    color_theme: document.documentElement.dataset.theme || undefined,
    ...params,
  });
}

function term(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, MAX_TERM_LENGTH) : undefined;
}

function pageView(): void {
  const url = new URL(window.location.href);
  const highlight = term(url.searchParams.get(HIGHLIGHT_PARAM));
  url.searchParams.delete(HIGHLIGHT_PARAM);
  const pageUrl = url.toString();
  // A mesma página enviada de novo (ao aceitar o consentimento) mantém o referrer que já tinha.
  if (pageUrl !== currentPageUrl) {
    currentReferrer = currentPageUrl ?? (document.referrer || undefined);
    currentPageUrl = pageUrl;
  }
  track('page_view', { page_location: pageUrl, page_title: document.title, page_referrer: currentReferrer });
  if (highlight) track('search_result_open', { search_term: highlight });
  if (isSearchPage(url.pathname)) trackSearch(url.searchParams.get('q'), 'search_page');
}

function isSearchPage(pathname: string): boolean {
  return /\/search\/?$/.test(pathname);
}

// A mesma busca digitada de novo (ou repetida na URL) conta uma vez só.
let lastSearch: string | undefined;
function trackSearch(value: string | null | undefined, source: string): void {
  const searchTerm = term(value);
  if (!searchTerm || searchTerm.length < 2 || searchTerm === lastSearch) return;
  lastSearch = searchTerm;
  track('search', { search_term: searchTerm, search_source: source });
}

function codeLanguage(element: Element | null): string | undefined {
  const block = element?.closest('.theme-code-block, pre');
  return block?.className.match(/language-([\w-]+)/)?.[1];
}

function onClick(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const hashLink = target.closest<HTMLAnchorElement>('a.hash-link');
  if (hashLink) {
    track('heading_link_click', { heading_id: hashLink.hash.slice(1) || undefined });
    return;
  }
  const editLink = target.closest<HTMLAnchorElement>('a.theme-edit-this-page');
  if (editLink) {
    track('edit_page_click', { link_url: editLink.href });
    return;
  }
  const pagination = target.closest<HTMLAnchorElement>('a.pagination-nav__link');
  if (pagination) {
    track('pagination_click', {
      direction: pagination.classList.contains('pagination-nav__link--next') ? 'next' : 'previous',
      link_url: pagination.href,
    });
    return;
  }
  const tab = target.closest<HTMLElement>('.tabs [role="tab"]');
  if (tab) {
    track('tab_select', { tab_label: term(tab.textContent) });
    return;
  }
  const localeLink = target.closest<HTMLAnchorElement>('a.dropdown__link[lang]');
  if (localeLink) {
    track('locale_switch', { to_locale: localeLink.lang });
  }
}

// Cópia por seleção (Ctrl+C) de dentro de um bloco de código. O botão de copiar é medido no CopyButton.
function onCopy(): void {
  const node = document.getSelection()?.anchorNode;
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  if (!element?.closest('pre')) return;
  track('copy_code', { method: 'selection', language: codeLanguage(element) });
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;
function onInput(event: Event): void {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.classList.contains('navbar__search-input')) return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => trackSearch(input.value, 'navbar'), SEARCH_DEBOUNCE_MS);
}

function start(): void {
  if (!MEASUREMENT_ID) return;
  if (getConsent() === 'granted') load();
  onConsentChange((value: Consent) => {
    if (value === 'granted') {
      const wasLoaded = loaded;
      load();
      if (wasLoaded) window.gtag?.('consent', 'update', { analytics_storage: 'granted' });
      pageView();
    } else {
      revoke();
    }
  });
  document.addEventListener('click', onClick, { capture: true });
  document.addEventListener('copy', onCopy);
  document.addEventListener('input', onInput);
}

if (ExecutionEnvironment.canUseDOM) start();

const clientModule: ClientModule = {
  onRouteDidUpdate({ location, previousLocation }) {
    if (!MEASUREMENT_ID) return;
    // Mudança só de âncora ou de query na mesma página (a página de busca reescreve ?q= a cada tecla)
    // não é uma nova visualização.
    if (previousLocation && location.pathname === previousLocation.pathname) {
      if (isSearchPage(location.pathname)) {
        clearTimeout(searchTimer);
        const q = new URLSearchParams(location.search).get('q');
        searchTimer = setTimeout(() => trackSearch(q, 'search_page'), SEARCH_DEBOUNCE_MS);
      }
      return;
    }
    // O título da página nova é aplicado depois da renderização (react-helmet); espera ele mudar, por até 1 s.
    const previousTitle = document.title;
    const started = Date.now();
    const send = (): void => {
      if (previousLocation && document.title === previousTitle && Date.now() - started < TITLE_WAIT_MS) {
        setTimeout(send, 50);
        return;
      }
      pageView();
    };
    setTimeout(send);
  },
};

export default clientModule;
