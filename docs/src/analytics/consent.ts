// A escolha da pessoa sobre o analytics do site, guardada só no navegador dela.
// Sem escolha registrada (ou com ela vencida), nada é medido e o banner aparece.

export type Consent = 'granted' | 'denied';

const KEY = 'cabecao:analytics-consent';
const EVENT = 'cabecao:analytics-consent';
// A escolha vale por um ano; depois o banner pergunta de novo.
const MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

export function getConsent(): Consent | undefined {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return undefined;
    const { value, at } = JSON.parse(raw) as { value?: unknown; at?: unknown };
    if (value !== 'granted' && value !== 'denied') return undefined;
    if (typeof at !== 'string' || Date.now() - Date.parse(at) > MAX_AGE_MS) return undefined;
    return value;
  } catch {
    // Armazenamento bloqueado (aba anônima, política do navegador): conta como sem escolha.
    return undefined;
  }
}

export function setConsent(value: Consent): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ value, at: new Date().toISOString() }));
  } catch {
    // Sem armazenamento a escolha vale só para esta página.
  }
  window.dispatchEvent(new CustomEvent<Consent>(EVENT, { detail: value }));
}

export function onConsentChange(listener: (value: Consent) => void): () => void {
  const handler = (event: Event): void => listener((event as CustomEvent<Consent>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
