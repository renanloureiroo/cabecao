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

/** Tamanho em bytes para o terminal: `812 B`, `14,2 kB`, `7,8 MB` (potências de 1000, como o `npm pack`). */
export function formatBytes(bytes: number): string {
  const units: readonly [number, string][] = [
    [1e9, 'GB'],
    [1e6, 'MB'],
    [1e3, 'kB'],
  ];
  for (const [size, unit] of units) {
    if (bytes >= size) return `${(bytes / size).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} ${unit}`;
  }
  return `${bytes} B`;
}
