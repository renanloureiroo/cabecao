// O que o site de documentação mede, e o controle para a pessoa mudar a escolha a qualquer momento.
// Trata só do site; a privacidade do Cabeção (o programa) fica na página "Segurança e privacidade".
import Link from '@docusaurus/Link';
import Translate, { translate } from '@docusaurus/Translate';
import { type Consent, getConsent, onConsentChange, setConsent } from '@site/src/analytics/consent';
import { useAnalyticsEnabled } from '@site/src/components/ConsentBanner';
import Heading from '@theme/Heading';
import Layout from '@theme/Layout';
import { type ReactNode, useEffect, useState } from 'react';
import styles from './privacidade.module.css';

function Choice(): ReactNode {
  const enabled = useAnalyticsEnabled();
  const [consent, setState] = useState<Consent | undefined>(undefined);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setState(getConsent());
    setReady(true);
    return onConsentChange(setState);
  }, []);

  if (!enabled) {
    return (
      <p className={styles.status}>
        <Translate id="privacy.choice.disabled">Este build do site não tem analytics: nada é medido.</Translate>
      </p>
    );
  }
  if (!ready) return null;

  const status =
    consent === 'granted'
      ? translate({ id: 'privacy.choice.granted', message: 'Você aceitou a medição.' })
      : consent === 'denied'
        ? translate({ id: 'privacy.choice.denied', message: 'Você recusou a medição.' })
        : translate({ id: 'privacy.choice.none', message: 'Você ainda não escolheu; por enquanto nada é medido.' });

  return (
    <div className={styles.choice}>
      <p className={styles.status} aria-live="polite">
        {status}
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          className="button button--secondary"
          disabled={consent === 'denied'}
          onClick={() => setConsent('denied')}
        >
          <Translate id="privacy.choice.deny">Recusar</Translate>
        </button>
        <button
          type="button"
          className="button button--primary"
          disabled={consent === 'granted'}
          onClick={() => setConsent('granted')}
        >
          <Translate id="privacy.choice.accept">Aceitar</Translate>
        </button>
      </div>
    </div>
  );
}

export default function Privacidade(): ReactNode {
  return (
    <Layout
      title={translate({ id: 'privacy.title', message: 'Privacidade do site' })}
      description={translate({
        id: 'privacy.description',
        message: 'O que o site de documentação do Cabeção mede com o Google Analytics, e como mudar a sua escolha.',
      })}
    >
      <main className={`container ${styles.page}`}>
        <Heading as="h1">
          <Translate id="privacy.title">Privacidade do site</Translate>
        </Heading>
        <p>
          <Translate id="privacy.intro">
            Esta página trata só deste site de documentação. Com a sua permissão, ele usa o Google Analytics 4 para
            saber quais páginas são lidas, o que as pessoas buscam e onde a documentação falha. Sem permissão, o script
            do Google nem é baixado.
          </Translate>
        </p>

        <Heading as="h2">
          <Translate id="privacy.collected.title">O que é medido</Translate>
        </Heading>
        <ul>
          <li>
            <Translate id="privacy.collected.pages">
              As páginas visitadas, de onde você veio, o tempo na página e se você chegou ao fim dela.
            </Translate>
          </li>
          <li>
            <Translate id="privacy.collected.context">
              País e cidade aproximados, idioma, navegador, sistema e tipo de aparelho, e o tema (claro ou escuro).
            </Translate>
          </li>
          <li>
            <Translate id="privacy.collected.actions">
              O que você faz na documentação: termos buscados, comandos e blocos de código copiados, abas escolhidas,
              links externos abertos e endereços que deram 404.
            </Translate>
          </li>
        </ul>

        <Heading as="h2">
          <Translate id="privacy.not.title">O que não é feito</Translate>
        </Heading>
        <ul>
          <li>
            <Translate id="privacy.not.ads">
              Nada de anúncios, remarketing ou Google Signals: os sinais de publicidade ficam sempre desligados.
            </Translate>
          </li>
          <li>
            <Translate id="privacy.not.ip">
              O GA4 não guarda o seu endereço IP, e o site não envia nome, e-mail ou qualquer dado que identifique você.
            </Translate>
          </li>
          <li>
            <Translate id="privacy.not.cli">
              O programa cabecao não envia telemetria nenhuma; isto vale só para o site.
            </Translate>
          </li>
        </ul>

        <Heading as="h2">
          <Translate id="privacy.choice.title">A sua escolha</Translate>
        </Heading>
        <p>
          <Translate id="privacy.choice.body">
            A escolha fica guardada só no seu navegador, por um ano. Ao recusar depois de ter aceitado, a medição para e
            os cookies do Google Analytics deste site são apagados.
          </Translate>
        </p>
        <Choice />

        <p className={styles.more}>
          <Translate
            id="privacy.more"
            values={{
              link: (
                <Link to="/seguranca/">
                  <Translate id="privacy.more.link">Segurança e privacidade</Translate>
                </Link>
              ),
            }}
          >
            {'Sobre os dados do seu cérebro e o que o programa faz com eles, veja {link}.'}
          </Translate>
        </p>
      </main>
    </Layout>
  );
}
