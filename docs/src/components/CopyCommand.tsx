// O comando de instalação num bloco de terminal com botão de copiar.
import { translate } from '@docusaurus/Translate';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import styles from './CopyCommand.module.css';
import Icon from './Icon';

export default function CopyCommand({ command }: { readonly command: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Sem permissão para a área de transferência: o comando continua selecionável.
    }
  };

  const label = copied
    ? translate({ id: 'home.copy.done', message: 'Copiado' })
    : translate({ id: 'home.copy.label', message: 'Copiar comando' });

  return (
    <div className={styles.box}>
      <code className={styles.code}>
        <span className={styles.prompt} aria-hidden="true">
          $
        </span>
        {command}
      </code>
      <button type="button" className={styles.button} onClick={copy} aria-label={label} title={label}>
        <Icon name={copied ? 'check' : 'copy'} />
      </button>
      <span className={styles.status} aria-live="polite">
        {copied ? label : ''}
      </span>
    </div>
  );
}
