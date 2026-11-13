// O símbolo do Cabeção desenhado da grade 16 x 16 (a mesma de assets/marca): a cabeça C_ com o cursor dentro.
import type { ReactNode } from 'react';

const GRADE = [
  '................',
  '................',
  '................',
  '....#######.....',
  '...#########....',
  '..###.....###...',
  '..##........##..',
  '..##........##..',
  '..##............',
  '..##..cccc.###..',
  '..###.cccc##....',
  '...########.....',
  '....####........',
  '....####........',
  '................',
  '................',
];

function runs(ch: string): string {
  let d = '';
  GRADE.forEach((row, y) => {
    let x = 0;
    while (x < 16) {
      if (row[x] === ch) {
        const start = x;
        while (x < 16 && row[x] === ch) x++;
        d += `M${start} ${y}h${x - start}v1h${start - x}z`;
      } else x++;
    }
  });
  return d;
}

const HEAD = runs('#');
const CURSOR = runs('c');

interface Props {
  readonly size: number;
  /** Desenha o quadrado de fundo com cantos de 22%. */
  readonly tile?: boolean;
  /** O cursor pisca em degrau a cada 1,06 s (parado com "reduzir movimento"). */
  readonly blink?: boolean;
  readonly className?: string;
  readonly title?: string;
}

/** As cores vêm do CSS: .cb-tile, .cb-head e .cb-cursor (ou as variáveis --cb-tile, --cb-head, --cb-cursor). */
export default function Cabeca({ size, tile = false, blink = false, className, title }: Props): ReactNode {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {tile && <rect width="16" height="16" rx="3.52" fill="var(--cb-tile)" />}
      <path d={HEAD} fill="var(--cb-head)" />
      <path d={CURSOR} fill="var(--cb-cursor)" className={blink ? 'cb-blink' : undefined} />
    </svg>
  );
}
