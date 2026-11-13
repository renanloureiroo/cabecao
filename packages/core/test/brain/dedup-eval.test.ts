// Medição dos limiares de duplicata (doc 07, "Duplicatas e contradições") no cérebro de exemplo, sem LLM:
//
// - falsos "duplicado": todo par de notas DISTINTAS do mesmo tipo e escopo comparado pela regra (cada uma no papel
//   de memória nova diante da outra). Nenhum par pode virar "igual", "já está na outra" nem "complementa"; as únicas
//   contradições aceitas são as dos fatos com o mesmo sujeito e predicado (que o próprio exemplo encadeia);
// - acertos: cada nota gravada de novo com o mesmo texto é reconhecida como igual.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DedupVerdict, MemoryText } from '../../src/brain/similarity.ts';
import { compareMemories, DEDUP_THRESHOLDS, factKey, memoryTerms } from '../../src/brain/similarity.ts';
import { splitFrontmatter } from '../../src/markdown/index.ts';
import { listNoteFiles, readBrainConfig } from '../../src/vault/index.ts';
import { FIXTURE_VAULT } from './helpers.ts';

interface FixtureNote {
  readonly path: string;
  readonly type: string;
  readonly scope: string;
  readonly text: MemoryText;
}

async function fixtureNotes(): Promise<FixtureNote[]> {
  const config = await readBrainConfig(FIXTURE_VAULT);
  const out: FixtureNote[] = [];
  for (const file of await listNoteFiles(FIXTURE_VAULT, config)) {
    if (file.path.startsWith('raw/') || file.path.startsWith('memory/_archive/')) continue;
    const split = splitFrontmatter(await readFile(join(FIXTURE_VAULT, ...file.diskPath.split('/')), 'utf8'));
    const fm = (split.data ?? {}) as Record<string, unknown>;
    if (typeof fm.type !== 'string') continue;
    const fact =
      fm.type === 'fact'
        ? { subject: String(fm.subject), predicate: String(fm.predicate), object: String(fm.object) }
        : null;
    out.push({
      path: file.path,
      type: fm.type,
      scope: typeof fm.scope === 'string' ? fm.scope : fm.type === 'fact' ? '' : 'global',
      text: { title: typeof fm.title === 'string' ? fm.title : '', body: split.body, fact },
    });
  }
  return out;
}

describe('limiares de duplicata no cérebro de exemplo', () => {
  it('nenhum falso "duplicado" entre notas distintas; toda nota repetida é reconhecida', async () => {
    const notes = await fixtureNotes();
    expect(notes.length).toBeGreaterThan(20);
    const verdicts: Record<DedupVerdict, number> = {
      duplicate: 0,
      subsumed: 0,
      complement: 0,
      contradiction: 0,
      ambiguous: 0,
      distinct: 0,
    };
    const wrong: string[] = [];
    const contradictions: string[] = [];
    let pairs = 0;
    for (const a of notes) {
      for (const b of notes) {
        if (a === b || a.type !== b.type) continue;
        const sameScope =
          a.type === 'fact' ? a.scope === '' || b.scope === '' || a.scope === b.scope : a.scope === b.scope;
        if (!sameScope) continue;
        pairs++;
        const { verdict } = compareMemories(a.text, b.text);
        verdicts[verdict]++;
        if (verdict === 'duplicate' || verdict === 'subsumed' || verdict === 'complement') {
          wrong.push(`${a.path} × ${b.path}: ${verdict}`);
        }
        if (verdict === 'contradiction') contradictions.push(`${a.path} × ${b.path}`);
      }
    }
    expect(wrong).toEqual([]);
    // as duas contradições do exemplo (RabbitMQ → SQS; Ana → Bruno), nos dois sentidos
    for (const line of contradictions) expect(line).toMatch(/fato-(atlas-usa|.*-lidera-atlas)/);
    expect(contradictions.length).toBe(4);

    let recognized = 0;
    for (const note of notes) {
      if (compareMemories(note.text, note.text).verdict === 'duplicate') recognized++;
    }
    expect(recognized).toBe(notes.length);
    // a medição que vai para a documentação
    expect({ notes: notes.length, pairs, ...verdicts }).toMatchObject({ duplicate: 0, subsumed: 0, complement: 0 });
  });
});

describe('compareMemories', () => {
  const page = (title: string, body: string): MemoryText => ({ title, body });
  const long =
    'Os testes de integração do Atlas falham quando o banco de teste não é limpo entre as execuções; rode o reset antes de cada suíte.';

  it('texto idêntico é igual, mesmo com outra pontuação e outro título', () => {
    expect(compareMemories(page('A', long), page('B', `${long.replace(';', ',')}\n`)).verdict).toBe('duplicate');
  });

  it('uma negação a mais nunca é "igual"', () => {
    const negated = long.replace('rode o reset', 'não rode o reset');
    const verdict = compareMemories(page('A', negated), page('A', long)).verdict;
    expect(verdict).not.toBe('duplicate');
    expect(verdict).not.toBe('complement');
    expect(verdict).toBe('ambiguous');
  });

  it('um número trocado vira ambíguo (pode ser uma correção)', () => {
    const a =
      'Os consumidores do Atlas leem do SQS em lotes de 10 mensagens por chamada, com espera longa de 20 segundos.';
    const b = a.replace('lotes de 10', 'lotes de 25');
    expect(compareMemories(page('Lotes', b), page('Lotes', a)).verdict).toBe('ambiguous');
  });

  it('a nova com tudo da antiga e mais complementa; a contida na antiga já está lá', () => {
    const extra = `${long} Use o comando make db-reset, que também recria as filas locais e apaga os arquivos temporários.`;
    expect(compareMemories(page('X', extra), page('X', long)).verdict).toBe('complement');
    expect(compareMemories(page('X', long), page('X', extra)).verdict).toBe('subsumed');
  });

  it('texto curto só é igual se for idêntico', () => {
    expect(compareMemories(page('g1', 'x'), page('g2', 'x')).verdict).toBe('distinct');
    expect(compareMemories(page('Paralela 1', 'Conteúdo 1.'), page('Paralela 2', 'Conteúdo 2.')).verdict).toBe(
      'distinct',
    );
    expect(compareMemories(page('Igual', 'curto'), page('igual', 'Curto.')).verdict).toBe('duplicate');
  });

  it('fatos: mesmo sujeito e predicado com outro objeto é contradição; outro predicado nunca é igual', () => {
    const fact = (subject: string, predicate: string, object: string): MemoryText => ({
      title: '',
      body: 'texto qualquer',
      fact: { subject, predicate, object },
    });
    expect(
      compareMemories(
        fact('[[Projeto Atlas]]', 'uses_queue', 'Kafka'),
        fact('[[Projeto Atlas]]', 'uses_queue', '[[SQS]]'),
      ).verdict,
    ).toBe('contradiction');
    expect(
      compareMemories(fact('Projeto Atlas', 'uses_queue', 'sqs'), fact('[[Projeto Atlas]]', 'uses_queue', '[[SQS]]'))
        .verdict,
    ).toBe('duplicate');
    expect(
      compareMemories(
        fact('[[Projeto Atlas]]', 'led_by', '[[SQS]]'),
        fact('[[Projeto Atlas]]', 'uses_queue', '[[SQS]]'),
      ).verdict,
    ).toBe('distinct');
  });

  it('o cosseno alto só torna ambíguo o que as palavras não decidiram', () => {
    const a = page(
      'Fila',
      'Trocamos o broker de mensagens por um serviço gerenciado para reduzir plantão e custo operacional.',
    );
    const b = page(
      'SQS',
      'Migramos do RabbitMQ autogerido para o SQS da AWS em maio, por causa das intervenções manuais.',
    );
    expect(compareMemories(a, b).verdict).toBe('distinct');
    expect(compareMemories(a, b, { cosine: DEDUP_THRESHOLDS.semanticAmbiguous }).verdict).toBe('ambiguous');
  });

  it('termos: negação e números ficam; palavras vazias saem; identificadores compostos ficam inteiros', () => {
    expect([...memoryTerms('Não use o proc-a em 2026-05-03')]).toEqual(['nao', 'use', 'proc-a', '2026-05-03']);
    expect(factKey('[[pasta/Projeto Atlas|Atlas]]')).toBe('projeto atlas');
  });
});
