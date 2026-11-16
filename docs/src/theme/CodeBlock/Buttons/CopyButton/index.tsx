// O botão de copiar dos blocos de código, igual ao do tema, contando a cópia no analytics.
import type { WrapperProps } from '@docusaurus/types';
import { track } from '@site/src/analytics/gtag';
import type CopyButtonType from '@theme/CodeBlock/Buttons/CopyButton';
import CopyButton from '@theme-original/CodeBlock/Buttons/CopyButton';
import type { MouseEvent, ReactNode } from 'react';

type Props = WrapperProps<typeof CopyButtonType>;

function onClick(event: MouseEvent<HTMLSpanElement>): void {
  // O bloco leva a linguagem na classe (language-bash, language-json...).
  const block = event.currentTarget.closest('.theme-code-block');
  track('copy_code', { method: 'button', language: block?.className.match(/language-([\w-]+)/)?.[1] });
}

export default function CopyButtonWrapper(props: Props): ReactNode {
  return (
    // display: contents mantém o botão do tema no mesmo lugar do grupo de botões.
    <span style={{ display: 'contents' }} onClickCapture={onClick}>
      <CopyButton {...props} />
    </span>
  );
}
