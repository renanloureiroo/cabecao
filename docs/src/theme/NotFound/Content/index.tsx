// A página 404 do tema, contando no analytics o endereço quebrado e de onde a pessoa veio.
import type { WrapperProps } from '@docusaurus/types';
import { track } from '@site/src/analytics/gtag';
import type ContentType from '@theme/NotFound/Content';
import Content from '@theme-original/NotFound/Content';
import { type ReactNode, useEffect } from 'react';

type Props = WrapperProps<typeof ContentType>;

export default function ContentWrapper(props: Props): ReactNode {
  useEffect(() => {
    track('page_not_found', {
      page_path: window.location.pathname,
      page_referrer: document.referrer || undefined,
    });
  }, []);
  return <Content {...props} />;
}
