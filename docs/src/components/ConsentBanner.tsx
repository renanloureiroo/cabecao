// Pergunta, uma vez, se o site pode medir as visitas com o Google Analytics.
// Só aparece quando o build tem um ID do GA e a pessoa ainda não escolheu (ou a escolha venceu).
import Link from '@docusaurus/Link';
import Translate from '@docusaurus/Translate';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import { type Consent, getConsent, onConsentChange, setConsent } from '@site/src/analytics/consent';
import { type ReactNode, useEffect, useState } from 'react';
import styles from './ConsentBanner.module.css';

export function useAnalyticsEnabled(): boolean {
  const { siteConfig } = useDocusaurusContext();
  const id = siteConfig.customFields?.gaMeasurementId;
  return typeof id === 'string' && id.length > 0;
}

export default function ConsentBanner(): ReactNode {
  const enabled = useAnalyticsEnabled();
  // Decidido só no navegador, depois da hidratação: o HTML estático sai sem o banner.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!enabled) return undefined;
    setOpen(getConsent() === undefined);
    return onConsentChange(() => setOpen(false));
  }, [enabled]);

  if (!open) return null;

  const choose = (value: Consent) => () => setConsent(value);

  return (
    <section className={styles.banner} aria-labelledby="consent-title" aria-describedby="consent-body">
      <p id="consent-title" className={styles.title}>
        <span aria-hidden="true">{'// '}</span>
        <Translate id="consent.banner.title">analytics</Translate>
      </p>
      <p id="consent-body" className={styles.body}>
        <Translate
          id="consent.banner.body"
          values={{
            link: (
              <Link to="/privacidade/">
                <Translate id="consent.banner.link">Saiba o que é coletado</Translate>
              </Link>
            ),
          }}
        >
          {
            'Posso medir as visitas com o Google Analytics (cookies, sem anúncios) para saber quais páginas ajudam? {link}.'
          }
        </Translate>
      </p>
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={choose('denied')}>
          <Translate id="consent.banner.deny">Recusar</Translate>
        </button>
        <button type="button" className={styles.primary} onClick={choose('granted')}>
          <Translate id="consent.banner.accept">Aceitar</Translate>
        </button>
      </div>
    </section>
  );
}
