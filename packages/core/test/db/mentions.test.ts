// Menções sem link (marco 3): o casamento palavra a palavra, o dicionário, a precisão e a cobertura medidas num
// conjunto montado sobre o cérebro de exemplo, e a atualização incremental a cada varredura.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  blankNonProse,
  buildMentionDictionary,
  findMentions,
  nameKey,
  nameProblem,
  reindexFull,
  scan,
} from '../../src/db/index.ts';
import { connection } from '../../src/db/open.ts';
import type { OpenVault } from './helpers.ts';
import { openFixture } from './helpers.ts';

const opened: OpenVault[] = [];
afterEach(async () => {
  for (const vault of opened.splice(0)) await vault.cleanup();
});

async function fixture(label: string): Promise<OpenVault> {
  const vault = await openFixture(label);
  opened.push(vault);
  return vault;
}

async function put(vault: OpenVault, path: string, text: string): Promise<void> {
  const full = join(vault.root, ...path.split('/'));
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, text);
}

/** Menções no banco: `origem → destino`, por caminho, ordenadas. */
function mentions(vault: OpenVault): string[] {
  return connection(vault.index)
    .prepare(
      `select s.path as src, d.path as dst from edges e
       join notes s on s.id = e.src_note join notes d on d.id = e.dst_note
       where e.origin = 'mention' order by s.path, d.path`,
    )
    .all()
    .map((row) => `${String(row.src)} → ${String(row.dst)}`);
}

const dict = (names: Record<string, string>) =>
  buildMentionDictionary(
    Object.entries(names).map(([name, noteId]) => ({
      noteId,
      name,
      kind: 'title' as const,
      noteType: 'entity',
      archived: false,
      conflictCopy: false,
    })),
  );

describe('casamento por dicionário', () => {
  it('nameKey: sem maiúsculas, sem acento, palavras separadas por um espaço', () => {
    expect(nameKey('Lumen  Logística')).toBe('lumen logistica');
    expect(nameKey('IDEMPOTÊNCIA')).toBe('idempotencia');
    expect(nameKey('Reunião de arquitetura 2026-05-03')).toBe('reuniao de arquitetura 2026 05 03');
    expect(nameKey('—')).toBe('');
  });

  it('nameProblem: curto, longo, só números e palavra genérica ficam de fora', () => {
    expect(nameProblem('Go')).toBe('short');
    expect(nameProblem('SQS')).toBeNull();
    expect(nameProblem('2026')).toBe('numeric');
    expect(nameProblem('Ideias')).toBe('common');
    expect(nameProblem('Projeto')).toBe('common');
    expect(nameProblem('Projeto Atlas')).toBeNull();
    expect(nameProblem('um dois três quatro cinco seis sete oito nove')).toBe('long');
  });

  it('palavra inteira, nome mais longo primeiro, sem sobreposição e com o separador do título', () => {
    const d = dict({
      'Projeto Atlas': 'atlas',
      'Mensageria no Projeto Atlas': 'sintese',
      SQS: 'sqs',
      'Reunião 2026-05-03': 'reuniao',
    });
    const found = (text: string) => findMentions(text, d).map((hit) => hit.entry.noteId);
    expect(found('A Mensageria no Projeto Atlas usa SQS.')).toEqual(['sintese', 'sqs']);
    expect(found('o projeto  atlas e o sqs')).toEqual(['atlas', 'sqs']);
    expect(found('PROJETO\nATLAS')).toEqual(['atlas']);
    expect(found('SQSX, XSQS, sqs_fila')).toEqual([]);
    expect(found('Projeto, Atlas')).toEqual([]);
    expect(found('Reunião 2026-05-03 e reunião, 2026/05/03')).toEqual(['reuniao']);
  });

  it('nome de duas notas é ambíguo e sai do dicionário; arquivada, cópia de conflito e fato não são destino', () => {
    const d = buildMentionDictionary([
      { noteId: 'a', name: 'Broker', kind: 'alias', noteType: 'entity', archived: false, conflictCopy: false },
      { noteId: 'b', name: 'broker', kind: 'alias', noteType: 'entity', archived: false, conflictCopy: false },
      { noteId: 'c', name: 'Antiga', kind: 'title', noteType: 'entity', archived: true, conflictCopy: false },
      { noteId: 'd', name: 'Copiada', kind: 'title', noteType: 'entity', archived: false, conflictCopy: true },
      {
        noteId: 'e',
        name: 'Projeto Atlas led_by Ana',
        kind: 'title',
        noteType: 'fact',
        archived: false,
        conflictCopy: false,
      },
    ]);
    expect([...d.entries.keys()]).toEqual([]);
  });

  it('código, wikilinks, endereço de link, URL e comentário HTML não são prosa', () => {
    const text = [
      'SQS aqui conta.',
      '```js',
      'SQS.send()',
      '```',
      'e `SQS` na linha não, nem [[SQS]], nem [doc](https://x.dev/SQS), nem https://sqs.example/SQS <!-- SQS -->',
    ].join('\n');
    const blanked = blankNonProse(text);
    expect(blanked.length).toBe(text.length);
    expect(blanked.split('\n').length).toBe(text.split('\n').length);
    expect(findMentions(blanked, dict({ SQS: 'sqs' })).map((hit) => hit.offset)).toEqual([0]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Precisão e cobertura num conjunto montado sobre o cérebro de exemplo

/**
 * Notas acrescentadas à cópia do cérebro de exemplo, com casos difíceis: caixa e acento diferentes, código, nome
 * dentro de outra palavra, apelido, nome ambíguo, título genérico e um falso positivo realista (a biblioteca
 * "Atlas" citada quando o texto fala do projeto).
 */
const EXTRA_NOTES: Record<string, string> = {
  'wiki/concepts/Backpressure.md': `---
id: 01KZ0000000000000000000001
type: concept
title: Backpressure
---
# Backpressure

Quando o sqs atrasa, o consumidor aplica backpressure. A lumen logistica sentiu isso no projeto atlas.

\`\`\`js
rabbitmq.connect('Idempotência');
\`\`\`

Um RabbitMQs no plural não é o nome, e o Projeto Atlantis também não. O \`Ana Prado\` em código não conta.
`,
  'wiki/entities/Kafka.md': `---
id: 01KZ0000000000000000000002
type: entity
title: Kafka
aliases: [Apache Kafka, Broker]
---
# Kafka

Log distribuído. A Ana Prado avaliou trocar o RabbitMQ por ele.
`,
  'wiki/entities/ActiveMQ.md': `---
id: 01KZ0000000000000000000003
type: entity
title: ActiveMQ
aliases: [Broker]
---
# ActiveMQ

Outro broker de mensagens. Ninguém no time quis migrar para o Apache Kafka.
`,
  'wiki/concepts/Ideias.md': `---
id: 01KZ0000000000000000000004
type: concept
title: Ideias
---
# Ideias

Ideias soltas sobre o broker: medir a fila de mensagens antes de trocar.
`,
  'wiki/entities/Atlas.md': `---
id: 01KZ0000000000000000000005
type: entity
title: Atlas
aliases: [Atlas JS]
---
# Atlas

Biblioteca de mapas usada na tela de rotas.
`,
  'memory/gotchas/tag-sem-changelog.md': `---
id: 01KZ0000000000000000000006
type: gotcha
title: Tag sem changelog
---
Criar a tag do Atlas antes de atualizar o changelog quebra a publicação. Avise o Bruno Tavares.
`,
};

/** Gabarito: as menções sem link que um leitor humano marcaria, por nota de origem. */
const GOLD: Record<string, string[]> = {
  'raw/meetings/2026-05-03-arquitetura.md': [
    'wiki/entities/Ana Prado.md',
    'wiki/entities/Bruno Tavares.md',
    'wiki/entities/Projeto Atlas.md',
    'wiki/entities/RabbitMQ.md',
    'wiki/entities/SQS.md',
  ],
  'memory/facts/fato-atlas-usa-sqs.md': ['wiki/entities/RabbitMQ.md'],
  'wiki/concepts/Backpressure.md': [
    'wiki/entities/SQS.md',
    'wiki/entities/Lumen Logística.md',
    'wiki/entities/Projeto Atlas.md',
  ],
  'wiki/entities/Kafka.md': ['wiki/entities/Ana Prado.md', 'wiki/entities/RabbitMQ.md'],
  'wiki/entities/ActiveMQ.md': ['wiki/entities/Kafka.md'],
  'wiki/concepts/Ideias.md': ['wiki/concepts/Fila de mensagens.md'],
  // "a tag do Atlas" fala do Projeto Atlas: a menção à biblioteca Atlas seria um falso positivo
  'memory/gotchas/tag-sem-changelog.md': ['wiki/entities/Bruno Tavares.md', 'wiki/entities/Projeto Atlas.md'],
};

describe('precisão e cobertura no cérebro de exemplo', () => {
  it('mede contra o gabarito e fica acima do mínimo', async () => {
    const vault = await fixture('mentions-eval');
    for (const [path, text] of Object.entries(EXTRA_NOTES)) await put(vault, path, text);
    await scan(vault.index, vault.root, vault.config);
    const found = new Set(mentions(vault));
    const gold = new Set(Object.entries(GOLD).flatMap(([src, dsts]) => dsts.map((dst) => `${src} → ${dst}`)));
    const tp = [...found].filter((pair) => gold.has(pair));
    const fp = [...found].filter((pair) => !gold.has(pair));
    const fn = [...gold].filter((pair) => !found.has(pair));
    const precision = tp.length / found.size;
    const recall = tp.length / gold.size;
    process.stderr.write(
      `\n[menções] encontradas ${found.size}, gabarito ${gold.size}, acertos ${tp.length}; precisão ${precision.toFixed(2)}, cobertura ${recall.toFixed(2)}\n  falsos positivos: ${fp.join('; ') || 'nenhum'}\n  não achadas: ${fn.join('; ') || 'nenhuma'}\n`,
    );
    // o falso positivo conhecido: "Atlas" sozinho é o título da biblioteca
    expect(fp).toEqual(['memory/gotchas/tag-sem-changelog.md → wiki/entities/Atlas.md']);
    // e a menção ao projeto, por isso mesmo, não é achada (o texto diz só "Atlas")
    expect(fn).toEqual(['memory/gotchas/tag-sem-changelog.md → wiki/entities/Projeto Atlas.md']);
    expect(precision).toBeGreaterThanOrEqual(0.9);
    expect(recall).toBeGreaterThanOrEqual(0.9);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Atualização incremental

describe('varredura incremental das menções', () => {
  it('nome novo acha o texto antigo; troca de título, link explícito e nota apagada refazem as menções', async () => {
    const vault = await fixture('mentions-incremental');
    await put(
      vault,
      'wiki/concepts/Lote.md',
      '---\nid: 01KZ0000000000000000000010\ntype: concept\ntitle: Lote\n---\nLer em leitura em lote poupa chamadas.\n',
    );
    await scan(vault.index, vault.root, vault.config);
    const episode = 'memory/episodes/2026/11/2026-11-10-migracao-dos-consumidores.md';
    expect(mentions(vault).filter((pair) => pair.startsWith(episode))).toEqual([]);

    // nota nova cujo título aparece num texto que não mudou
    await put(
      vault,
      'wiki/concepts/Consumidores restantes.md',
      '---\nid: 01KZ0000000000000000000011\ntype: concept\ntitle: Consumidores restantes\n---\nOs três que faltam.\n',
    );
    await scan(vault.index, vault.root, vault.config);
    const mentionOf = `${episode} → wiki/concepts/Consumidores restantes.md`;
    expect(mentions(vault)).toContain(mentionOf);

    // troca de título: a menção some
    await put(
      vault,
      'wiki/concepts/Consumidores restantes.md',
      '---\nid: 01KZ0000000000000000000011\ntype: concept\ntitle: Consumidores pendentes da migração\n---\nOs três que faltam.\n',
    );
    await scan(vault.index, vault.root, vault.config);
    expect(mentions(vault)).not.toContain(mentionOf);

    // link explícito no texto de origem: a menção vira desnecessária
    const raw = 'raw/meetings/2026-05-03-arquitetura.md';
    expect(mentions(vault)).toContain(`${raw} → wiki/entities/SQS.md`);
    await put(
      vault,
      raw,
      '# Reunião de arquitetura — 03/05/2026\n\nPresentes: Ana Prado.\n\nDecisão: migrar para [[SQS]] até o fim de maio.\n',
    );
    await scan(vault.index, vault.root, vault.config);
    expect(mentions(vault).filter((pair) => pair.startsWith(raw))).toEqual([`${raw} → wiki/entities/Ana Prado.md`]);

    // nota de destino apagada: as menções a ela somem
    await rm(join(vault.root, 'wiki', 'entities', 'Ana Prado.md'));
    await scan(vault.index, vault.root, vault.config);
    expect(mentions(vault).some((pair) => pair.endsWith('Ana Prado.md'))).toBe(false);

    // o resultado incremental é o mesmo de refazer tudo do zero
    const incremental = mentions(vault);
    await reindexFull(vault.index, vault.root, vault.config);
    expect(mentions(vault)).toEqual(incremental);
  });

  it('menções não aparecem como links de saída nem como backlinks do read, nem como links quebrados', async () => {
    const vault = await fixture('mentions-links');
    await scan(vault.index, vault.root, vault.config);
    const db = connection(vault.index);
    const count = db.prepare(`select count(*) as n from edges where origin = 'mention'`).get();
    expect(Number(count?.n)).toBeGreaterThan(0);
    const { outgoingLinks, backlinks, getNote, brokenLinks } = await import('../../src/db/index.ts');
    const raw = getNote(vault.index, { path: 'raw/meetings/2026-05-03-arquitetura.md' });
    expect(raw).not.toBeNull();
    expect(outgoingLinks(vault.index, raw?.id ?? '').some((link) => link.origin === 'mention')).toBe(false);
    const sqs = getNote(vault.index, { path: 'wiki/entities/SQS.md' });
    expect(backlinks(vault.index, sqs?.id ?? '').some((link) => link.origin === 'mention')).toBe(false);
    expect(brokenLinks(vault.index).some((link) => link.origin === 'mention')).toBe(false);
  });
});
