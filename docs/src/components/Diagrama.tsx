// Como o Cabeção funciona: notas em Markdown versionadas com git, um servidor MCP local e os agentes.
// Desenho autoral em SVG, na linguagem da marca: caixas de contorno, rótulos // em mono, linhas com pontas
// quadradas (nós de pixel) e o vermelho só no último commit, o cursor. Duas composições: larga e estreita.
import { translate } from '@docusaurus/Translate';
import type { ReactNode } from 'react';
import styles from './Diagrama.module.css';

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly title: string;
  readonly meta?: string;
}

interface Label {
  readonly x: number;
  readonly y: number;
  readonly text: string;
}

interface Layout {
  readonly w: number;
  readonly h: number;
  readonly group: { x: number; y: number; w: number; h: number };
  readonly labels: readonly Label[];
  readonly boxes: readonly Box[];
  readonly lines: readonly (readonly [number, number][])[];
  readonly tags: readonly Label[];
  readonly commits: { x: number; y: number; label: Label };
}

function texts() {
  return {
    you: translate({ id: 'home.diagram.you', message: '// você' }),
    editor: translate({ id: 'home.diagram.editor', message: 'Obsidian ou editor' }),
    editorMeta: translate({ id: 'home.diagram.editorMeta', message: 'lê e edita os .md' }),
    agents: translate({ id: 'home.diagram.agents', message: '// agentes de IA' }),
    others: translate({ id: 'home.diagram.others', message: 'e outros clientes MCP' }),
    machine: translate({ id: 'home.diagram.machine', message: '// esta máquina · ~/cabecao' }),
    notes: translate({ id: 'home.diagram.notes', message: 'Notas em Markdown' }),
    notesMeta: translate({ id: 'home.diagram.notesMeta', message: 'memórias, notas, regras' }),
    commits: translate({ id: 'home.diagram.commits', message: 'git: um commit por gravação' }),
    mcp: translate({ id: 'home.diagram.mcp', message: 'Servidor MCP local' }),
    mcpMeta: translate({ id: 'home.diagram.mcpMeta', message: 'cabecao mcp · stdio' }),
    index: translate({ id: 'home.diagram.index', message: 'Índice local' }),
    indexMeta: translate({ id: 'home.diagram.indexMeta', message: 'busca, grafo e fatos' }),
    remote: translate({ id: 'home.diagram.remote', message: '// remoto git' }),
    repo: translate({ id: 'home.diagram.repo', message: 'Seu repositório privado' }),
    repoMeta: translate({ id: 'home.diagram.repoMeta', message: 'GitHub, GitLab, Gitea…' }),
    other: translate({ id: 'home.diagram.other', message: '// outra máquina' }),
    otherMeta: translate({ id: 'home.diagram.otherMeta', message: 'o mesmo cérebro' }),
    title: translate({
      id: 'home.diagram.title',
      message:
        'Diagrama: você edita as notas no Obsidian ou num editor; os agentes de IA falam com o servidor MCP local, que lê e grava as notas e consulta o índice local; cada gravação é um commit, e o sync leva tudo ao seu repositório git e às outras máquinas.',
    }),
  };
}

function wide(t: ReturnType<typeof texts>): Layout {
  return {
    w: 1000,
    h: 432,
    group: { x: 330, y: 8, w: 340, h: 416 },
    labels: [
      { x: 0, y: 24, text: t.you },
      { x: 0, y: 144, text: t.agents },
      { x: 354, y: 40, text: t.machine },
      { x: 750, y: 144, text: t.remote },
      { x: 750, y: 288, text: t.other },
    ],
    boxes: [
      { x: 0, y: 40, w: 250, h: 64, title: t.editor, meta: t.editorMeta },
      { x: 0, y: 160, w: 250, h: 44, title: 'Claude Code' },
      { x: 0, y: 214, w: 250, h: 44, title: 'Codex' },
      { x: 0, y: 268, w: 250, h: 44, title: 'Cursor' },
      { x: 0, y: 322, w: 250, h: 44, title: t.others },
      { x: 354, y: 60, w: 292, h: 64, title: t.notes, meta: t.notesMeta },
      { x: 354, y: 236, w: 292, h: 64, title: t.mcp, meta: t.mcpMeta },
      { x: 354, y: 336, w: 292, h: 64, title: t.index, meta: t.indexMeta },
      { x: 750, y: 160, w: 250, h: 64, title: t.repo, meta: t.repoMeta },
      { x: 750, y: 304, w: 250, h: 64, title: '~/cabecao', meta: t.otherMeta },
    ],
    lines: [
      [
        [250, 72],
        [300, 72],
        [300, 92],
        [354, 92],
      ],
      [
        [250, 182],
        [290, 182],
        [290, 344],
        [250, 344],
      ],
      [
        [250, 236],
        [290, 236],
      ],
      [
        [250, 290],
        [290, 290],
      ],
      [
        [290, 268],
        [354, 268],
      ],
      [
        [380, 236],
        [380, 124],
      ],
      [
        [500, 300],
        [500, 336],
      ],
      [
        [646, 92],
        [700, 92],
        [700, 192],
        [750, 192],
      ],
      [
        [968, 224],
        [968, 304],
      ],
    ],
    tags: [
      { x: 298, y: 258, text: 'MCP' },
      { x: 708, y: 150, text: 'sync' },
      { x: 924, y: 262, text: 'sync' },
    ],
    commits: { x: 404, y: 176, label: { x: 404, y: 164, text: t.commits } },
  };
}

function narrow(t: ReturnType<typeof texts>): Layout {
  return {
    w: 360,
    h: 832,
    group: { x: 0, y: 236, w: 360, h: 380 },
    labels: [
      { x: 0, y: 16, text: t.you },
      { x: 0, y: 112, text: t.agents },
      { x: 20, y: 268, text: t.machine },
      { x: 0, y: 644, text: t.remote },
      { x: 0, y: 740, text: t.other },
    ],
    boxes: [
      { x: 0, y: 28, w: 172, h: 60, title: t.editor, meta: t.editorMeta },
      { x: 188, y: 124, w: 172, h: 40, title: 'Claude Code' },
      { x: 188, y: 172, w: 172, h: 40, title: 'Codex' },
      { x: 0, y: 124, w: 172, h: 40, title: 'Cursor' },
      { x: 0, y: 172, w: 172, h: 40, title: t.others },
      { x: 20, y: 284, w: 320, h: 60, title: t.notes, meta: t.notesMeta },
      { x: 20, y: 440, w: 320, h: 60, title: t.mcp, meta: t.mcpMeta },
      { x: 20, y: 532, w: 320, h: 60, title: t.index, meta: t.indexMeta },
      { x: 0, y: 656, w: 360, h: 60, title: t.repo, meta: t.repoMeta },
      { x: 0, y: 752, w: 360, h: 60, title: '~/cabecao', meta: t.otherMeta },
    ],
    lines: [
      [
        [86, 88],
        [86, 100],
        [300, 100],
        [300, 112],
        [300, 236],
      ],
      [
        [86, 212],
        [86, 224],
        [274, 224],
        [274, 212],
      ],
      [
        [180, 224],
        [180, 236],
      ],
      [
        [180, 236],
        [180, 440],
      ],
      [
        [300, 236],
        [300, 284],
      ],
      [
        [180, 500],
        [180, 532],
      ],
      [
        [180, 616],
        [180, 656],
      ],
      [
        [180, 716],
        [180, 752],
      ],
    ],
    tags: [
      { x: 188, y: 420, text: 'MCP' },
      { x: 188, y: 640, text: 'sync' },
      { x: 188, y: 738, text: 'sync' },
    ],
    commits: { x: 40, y: 380, label: { x: 40, y: 368, text: t.commits } },
  };
}

function Label({ x, y, text }: Label): ReactNode {
  const slash = text.startsWith('// ');
  return (
    <text x={x} y={y} className={styles.label}>
      {slash && <tspan className={styles.slash}>{'// '}</tspan>}
      {slash ? text.slice(3) : text}
    </text>
  );
}

function Drawing({ layout, className, title }: { layout: Layout; className: string; title: string }): ReactNode {
  const { group, commits } = layout;
  const nodes = layout.lines.flatMap((l) => [l[0], l[l.length - 1]]);
  return (
    <svg className={className} viewBox={`0 0 ${layout.w} ${layout.h}`} role="img" aria-label={title}>
      <rect x={group.x} y={group.y} width={group.w} height={group.h} rx="16" className={styles.group} />
      {layout.lines.map((l) => (
        <polyline
          key={l.map((p) => p.join(',')).join(' ')}
          points={l.map((p) => p.join(',')).join(' ')}
          className={styles.line}
        />
      ))}
      {nodes.map(([x, y]) => (
        <rect key={`n${x},${y}`} x={x - 3} y={y - 3} width="6" height="6" className={styles.node} />
      ))}
      {layout.boxes.map((b) => (
        <g key={`${b.x},${b.y}`}>
          <rect x={b.x} y={b.y} width={b.w} height={b.h} rx="8" className={styles.box} />
          <text x={b.x + 16} y={b.meta ? b.y + 27 : b.y + b.h / 2 + 5} className={styles.title}>
            {b.title}
          </text>
          {b.meta && (
            <text x={b.x + 16} y={b.y + 48} className={styles.meta}>
              {b.meta}
            </text>
          )}
        </g>
      ))}
      {layout.labels.map((l) => (
        <Label key={`${l.x},${l.y}`} {...l} />
      ))}
      {layout.tags.map((l) => (
        <text key={`${l.x},${l.y}`} x={l.x} y={l.y} className={styles.tag}>
          {l.text}
        </text>
      ))}
      <text x={commits.label.x} y={commits.label.y} className={styles.meta}>
        {commits.label.text}
      </text>
      <line x1={commits.x} y1={commits.y + 8} x2={commits.x + 6 * 36 + 16} y2={commits.y + 8} className={styles.line} />
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <rect
          key={i}
          x={commits.x + i * 36}
          y={commits.y}
          width="16"
          height="16"
          rx="2"
          className={i === 6 ? styles.commitHead : styles.commit}
        />
      ))}
    </svg>
  );
}

export default function Diagrama(): ReactNode {
  const t = texts();
  return (
    <figure className={styles.figure}>
      <Drawing layout={wide(t)} className={styles.wide} title={t.title} />
      <Drawing layout={narrow(t)} className={styles.narrow} title={t.title} />
    </figure>
  );
}
