// Raiz do site: o conteúdo de sempre e, por cima, o banner de consentimento do analytics.
import ConsentBanner from '@site/src/components/ConsentBanner';
import type { ReactNode } from 'react';

export default function Root({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <>
      {children}
      <ConsentBanner />
    </>
  );
}
