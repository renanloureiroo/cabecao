// Os 34 casos de correção do spike 14 (a prova de conceito de plataforma), portados um a um.
// A comparação é a mesma de lá: conjunto de links, lista de títulos, dados do frontmatter e presença de erro.
import { describe, expect, it } from 'vitest';
import { parseNote } from '../../src/markdown/index.ts';

type Kind = 'link' | 'embed' | 'mdlink';
interface ExpectedLink {
  kind: Kind;
  target: string;
  anchor: string | null;
  alias: string | null;
}
interface SpikeCase {
  name: string;
  src: string;
  links: ExpectedLink[];
  sections?: string[];
  data?: Record<string, unknown>;
  fmError?: true;
}

const L = (kind: Kind, target: string, anchor: string | null = null, alias: string | null = null): ExpectedLink => ({
  kind,
  target,
  anchor,
  alias,
});

const CASES: SpikeCase[] = [
  { name: 'wikilink simples', src: 'Ver [[Nota A]].', links: [L('link', 'Nota A')] },
  {
    name: 'alias [[nota|alias]]',
    src: 'Ver [[Nota A|apelido bonito]].',
    links: [L('link', 'Nota A', null, 'apelido bonito')],
  },
  {
    name: 'link para seção [[nota#seção]]',
    src: 'Ver [[Nota A#Custo de operação]].',
    links: [L('link', 'Nota A', 'Custo de operação')],
  },
  { name: 'seção + alias', src: 'Ver [[Nota A#Seção|txt]].', links: [L('link', 'Nota A', 'Seção', 'txt')] },
  { name: 'seção local [[#x]]', src: 'Ver [[#Contexto]].', links: [L('link', '', 'Contexto')] },
  {
    name: 'embed ![[...]]',
    src: 'Figura: ![[diagrama.png]] e ![[Nota A#Seção]]',
    links: [L('embed', 'diagrama.png'), L('embed', 'Nota A', 'Seção')],
  },
  {
    name: '[[ em bloco de código cercado',
    src: 'antes [[Real]]\n\n```js\nconst a = "[[Falso]]";\n# não é título\n```\n\ndepois',
    links: [L('link', 'Real')],
    sections: [],
  },
  {
    name: '[[ em cerca com til e cerca longa',
    src: '~~~\n[[Falso1]]\n~~~\n\n````md\n```\n[[Falso2]]\n```\n````\n\n[[Real]]',
    links: [L('link', 'Real')],
  },
  {
    name: '[[ em código inline',
    src: 'Use `[[Falso]]` e ``a `[[Falso2]]` b`` mas [[Real]].',
    links: [L('link', 'Real')],
  },
  { name: '[[ em código indentado', src: 'Parágrafo.\n\n    [[Falso]]\n\n[[Real]]', links: [L('link', 'Real')] },
  {
    name: 'frontmatter válido',
    src: '---\ntitle: "Olá"\ntags: [a, b]\n---\n# T\n[[X]]',
    links: [L('link', 'X')],
    sections: ['T'],
    data: { title: 'Olá', tags: ['a', 'b'] },
  },
  {
    name: 'frontmatter malformado não derruba',
    src: '---\ntitle: "sem fechar\nlista: [a, b\n  x: : y\n---\n# Título\n\nTexto [[X]].',
    links: [L('link', 'X')],
    sections: ['Título'],
    fmError: true,
  },
  { name: 'frontmatter vazio', src: '---\n---\n# T\n', sections: ['T'], links: [], data: {} },
  {
    name: 'frontmatter com BOM + CRLF',
    src: '﻿---\r\ntitle: Olá\r\n---\r\n# T\r\n\r\n[[X]]\r\n',
    links: [L('link', 'X')],
    sections: ['T'],
    data: { title: 'Olá' },
  },
  {
    name: '--- no corpo não é frontmatter',
    src: '# T\n\ntexto\n\n---\n\nchave: valor\n\n---\n\n[[X]]',
    links: [L('link', 'X')],
    sections: ['T'],
    data: {},
  },
  {
    name: 'CRLF em tudo',
    src: '# Um\r\n\r\nTexto [[A|b]]\r\n\r\n## Dois\r\n\r\n```\r\n[[Falso]]\r\n```\r\n',
    links: [L('link', 'A', null, 'b')],
    sections: ['Um', 'Dois'],
  },
  {
    name: 'wikilink no título',
    src: '## Decisão sobre [[SQS]]\n',
    links: [L('link', 'SQS')],
    sections: ['Decisão sobre [[SQS]]'],
  },
  {
    name: 'pipe escapado em tabela',
    src: '| a | b |\n|---|---|\n| [[Nota A\\|apelido]] | x |\n',
    links: [L('link', 'Nota A', null, 'apelido')],
  },
  {
    name: 'título setext',
    src: 'Título Um\n=========\n\nSub\n---\n\n[[X]]',
    links: [L('link', 'X')],
    sections: ['Título Um', 'Sub'],
  },
  {
    name: 'título com # de fechamento e sem espaço',
    src: '## Título ##\n\n#tag não é título\n\n#também-não',
    sections: ['Título'],
    links: [],
  },
  {
    name: 'link markdown relativo',
    src: 'Ver [outra](Pasta/Outra%20Nota.md#sec) e [site](https://x.dev) e ![img](a.png)',
    links: [L('mdlink', 'Pasta/Outra Nota', 'sec', 'outra'), L('embed', 'a.png', null, 'img')],
  },
  {
    name: 'wikilink com caminho',
    src: '[[Projetos/Cabeção/Plano|plano]]',
    links: [L('link', 'Projetos/Cabeção/Plano', null, 'plano')],
  },
  { name: 'colchetes escapados', src: 'Literal \\[\\[não é link\\]\\] e [[Real]]', links: [L('link', 'Real')] },
  {
    name: 'vários links na linha + ênfase',
    src: '**[[A]]**, *[[B|b]]* e [[C#s]] em lista:\n- [[D]]\n- item com [[E]] no meio',
    links: [L('link', 'A'), L('link', 'B', null, 'b'), L('link', 'C', 's'), L('link', 'D'), L('link', 'E')],
  },
  {
    name: 'wikilink com sublinhado/asterisco no nome',
    src: 'Ver [[plano_anual_2026]] e [[Nota *muito* boa]] e [[a_b|c_d]].',
    links: [L('link', 'plano_anual_2026'), L('link', 'Nota *muito* boa'), L('link', 'a_b', null, 'c_d')],
  },
  {
    name: 'título dentro de citação/lista não vira seção de topo (tolerado)',
    src: '# Real\n\n> citação com [[Q]]\n',
    links: [L('link', 'Q')],
    sections: ['Real'],
  },
  // casos "do contra": escritos no spike para tentar quebrar o parser próprio
  {
    name: 'cerca dentro de item de lista (4 espaços)',
    src: '- item\n\n    ```js\n    const a = "[[Falso]]";\n    ```\n\n- outro [[Real]]',
    links: [L('link', 'Real')],
  },
  {
    name: 'cerca dentro de citação',
    src: '> ```\n> [[Falso]]\n> # não é título\n> ```\n\n[[Real]]',
    links: [L('link', 'Real')],
    sections: [],
  },
  {
    name: 'cerca sem fechar até o fim',
    src: '[[Real]]\n\n```\n[[Falso]]\n# nada',
    links: [L('link', 'Real')],
    sections: [],
  },
  { name: 'comentário HTML', src: '<!-- [[Falso]] -->\n\n[[Real]]', links: [L('link', 'Real')] },
  { name: 'comentário do Obsidian %%', src: 'texto %%[[Falso]]%% e [[Real]]', links: [L('link', 'Real')] },
  { name: 'matriz em LaTeX', src: 'Seja $M = [[1,2],[3,4]]$ e [[Real]]', links: [L('link', 'Real')] },
  {
    name: 'título com código e ênfase',
    src: '## Uso de `npx` em **produção**\n',
    sections: ['Uso de npx em produção'],
    links: [],
  },
  {
    name: 'comentário de várias linhas',
    src: 'a [[Real]]\n\n%%\nrascunho [[Falso]]\n%%\n\n<!--\n[[Falso2]]\n-->\n\nb [[Real2]]',
    links: [L('link', 'Real'), L('link', 'Real2')],
  },
];

const key = (l: ExpectedLink): string => `${l.kind}:${l.target}#${l.anchor ?? ''}|${l.alias ?? ''}`;

describe('casos de correção do spike 14', () => {
  it('são os 34 casos', () => {
    expect(CASES).toHaveLength(34);
    expect(new Set(CASES.map((c) => c.name)).size).toBe(34);
  });

  it.each(CASES)('$name', (c) => {
    const note = parseNote(c.src);
    const got: ExpectedLink[] = [
      ...note.links.map((l) => L(l.embed ? 'embed' : 'link', l.target, l.anchor, l.alias)),
      ...note.markdownLinks.map((l) => L(l.embed ? 'embed' : 'mdlink', l.target, l.anchor, l.text)),
    ];
    expect(got.map(key).sort()).toEqual(c.links.map(key).sort());
    if (c.sections) expect(note.headings.map((h) => h.text)).toEqual(c.sections);
    if (c.data) expect(note.frontmatter).toEqual(c.data);
    if (c.fmError) expect(note.frontmatterError).not.toBeNull();
    else expect(note.frontmatterError).toBeNull();
  });
});
