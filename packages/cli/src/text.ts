// Pequenos ajudantes de texto para a saída dos comandos no terminal.

/** `1 nota`, `3 notas`. */
export function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** Data ISO 8601 como `AAAA-MM-DD HH:mm`, no fuso desta máquina. Texto que não é data volta como veio. */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Recuo de todas as linhas de um bloco. */
export function indent(text: string, prefix = '  '): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? line : `${prefix}${line}`))
    .join('\n');
}
