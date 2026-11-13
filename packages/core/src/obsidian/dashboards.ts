// Painéis do Obsidian (arquivos `.base`, plugin nativo Bases) que o `cabecao obsidian setup` grava em `dashboards/`
// (doc 09, "Painéis"). O pacote é um bundle sem arquivos soltos: o conteúdo vive aqui, como o modelo do cérebro em
// `init/template.ts`.
//
// Sintaxe conferida na documentação oficial (obsidian.md/help/bases/syntax e /functions): `filters` com `and`, `or`
// e `not`; `formulas`; `properties.<id>.displayName`; views `table` com `order`, `groupBy`, `sort`, `filters` e
// `limit`. E duas armadilhas medidas no aplicativo pelo spike 15 (item 8c): "propriedade ausente" é `prop == null`
// (`!prop` descarta a nota em silêncio), e diferença de datas é `(today() - data).days`.
//
// Nenhum painel executa nada: um `.base` só consulta as propriedades das notas. Nenhum caminho absoluto nem dado
// pessoal entra aqui.
import { createHash } from 'node:crypto';
import { OBSIDIAN_DASHBOARDS_DIR } from './settings.ts';

export interface DashboardFile {
  /** Caminho relativo à raiz do cérebro, com `/`. */
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly content: string;
}

const HEADER = (title: string): string =>
  `# ${title}. Gerado pelo "cabecao obsidian setup"; se você editar este painel, o Cabeção não o substitui mais.\n`;

/** Situação de uma nota com validade: vencida, ainda não vigente, substituída ou vigente. */
const SITUATION_FORMULA =
  'if(valid_until != null && valid_until < today(), "vencida", if(valid_from != null && valid_from > today(), "ainda não vigente", if(superseded_by == null || superseded_by.isEmpty(), "vigente", "substituída")))';

const MEMORIES = `${HEADER('Memórias ativas por tipo e escopo')}filters:
  and:
    - file.inFolder("memory")
    - file.ext == "md"
    - not:
        - file.inFolder("memory/_archive")
        - file.name.contains(".conflict-")
        - 'type == "episode"'
        - 'type == "handoff"'
    - or:
        - 'valid_until == null'
        - 'valid_until >= today()'
properties:
  note.type:
    displayName: Tipo
  note.scope:
    displayName: Escopo
  note.trust:
    displayName: Confiança
  note.updated:
    displayName: Atualizada
views:
  - type: table
    name: Por tipo
    order:
      - file.name
      - note.type
      - note.scope
      - note.trust
      - note.updated
    groupBy:
      property: note.type
      direction: ASC
    sort:
      - property: note.updated
        direction: DESC
  - type: table
    name: Por escopo
    order:
      - file.name
      - note.scope
      - note.type
      - note.updated
    groupBy:
      property: note.scope
      direction: ASC
    sort:
      - property: note.updated
        direction: DESC
`;

const REVIEW = `${HEADER('Memórias para revisar')}filters:
  and:
    - file.inFolder("memory")
    - file.ext == "md"
    - 'valid_until == null'
    - not:
        - file.inFolder("memory/_archive")
        - file.name.contains(".conflict-")
        - 'type == "episode"'
        - 'type == "handoff"'
formulas:
  motivo: 'if(edited_by != null, "editada por agente", if(trust == "low", "confiança baixa", if(confirmed == null, "nunca confirmada", "confirmação antiga")))'
  dias_sem_confirmar: 'if(confirmed == null, "", (today() - confirmed).days)'
properties:
  formula.motivo:
    displayName: Motivo
  formula.dias_sem_confirmar:
    displayName: Dias sem confirmar
  note.edited_by:
    displayName: Editada por
views:
  - type: table
    name: Precisam de revisão
    filters:
      or:
        - 'trust == "low"'
        - 'confirmed == null'
        - 'confirmed < today() - "180d"'
        - 'edited_by != null'
    order:
      - file.name
      - note.type
      - note.scope
      - note.confirmed
      - formula.dias_sem_confirmar
      - formula.motivo
    groupBy:
      property: formula.motivo
      direction: ASC
  - type: table
    name: Editadas por agente
    filters:
      and:
        - 'edited_by != null'
    order:
      - file.name
      - note.edited_by
      - note.trust
      - note.origin
      - note.updated
    sort:
      - property: note.updated
        direction: DESC
`;

const DECISIONS = `${HEADER('Decisões vigentes e vencidas')}filters:
  and:
    - file.ext == "md"
    - or:
        - file.inFolder("wiki/decisions")
        - 'type == "decision"'
    - not:
        - file.inFolder("memory/_archive")
        - file.name.contains(".conflict-")
formulas:
  situacao: '${SITUATION_FORMULA}'
properties:
  formula.situacao:
    displayName: Situação
  note.supersedes:
    displayName: Substitui
  note.superseded_by:
    displayName: Substituída por
views:
  - type: table
    name: Vigentes
    filters:
      and:
        - 'formula.situacao == "vigente"'
    order:
      - file.name
      - note.scope
      - note.valid_from
      - note.supersedes
    sort:
      - property: note.valid_from
        direction: DESC
  - type: table
    name: Todas por situação
    order:
      - file.name
      - formula.situacao
      - note.valid_from
      - note.valid_until
      - note.supersedes
      - note.superseded_by
    groupBy:
      property: formula.situacao
      direction: ASC
`;

const FACTS = `${HEADER('Fatos por validade')}filters:
  and:
    - file.ext == "md"
    - or:
        - file.inFolder("memory/facts")
        - 'type == "fact"'
    - not:
        - file.inFolder("memory/_archive")
        - file.name.contains(".conflict-")
formulas:
  situacao: '${SITUATION_FORMULA}'
properties:
  note.subject:
    displayName: Sujeito
  note.predicate:
    displayName: Predicado
  note.object:
    displayName: Objeto
  formula.situacao:
    displayName: Situação
views:
  - type: table
    name: Vigentes
    filters:
      and:
        - 'formula.situacao == "vigente"'
    order:
      - note.subject
      - note.predicate
      - note.object
      - note.valid_from
    groupBy:
      property: note.subject
      direction: ASC
  - type: table
    name: Vencidos e substituídos
    filters:
      or:
        - 'formula.situacao == "vencida"'
        - 'formula.situacao == "substituída"'
    order:
      - note.subject
      - note.predicate
      - note.object
      - note.valid_from
      - note.valid_until
      - note.superseded_by
  - type: table
    name: Todos por situação
    order:
      - note.subject
      - note.predicate
      - note.object
      - note.valid_from
      - note.valid_until
    groupBy:
      property: formula.situacao
      direction: ASC
`;

const HEALTH = `${HEADER('Saúde do cérebro')}filters:
  and:
    - file.ext == "md"
    - not:
        - file.inFolder("memory/_archive")
properties:
  note.edited_by:
    displayName: Editada por
views:
  - type: table
    name: Conflitos de sync pendentes
    filters:
      and:
        - file.name.contains(".conflict-")
    order:
      - file.name
      - file.folder
      - file.mtime
  - type: table
    name: Notas da wiki sem fonte
    filters:
      and:
        - file.inFolder("wiki")
        - not:
            - file.inFolder("wiki/sources")
            - file.name.contains(".conflict-")
        - or:
            - 'sources == null'
            - 'sources.isEmpty()'
    order:
      - file.name
      - note.type
      - note.trust
      - note.origin
  - type: table
    name: Editadas por agente
    filters:
      and:
        - 'edited_by != null'
    order:
      - file.name
      - note.edited_by
      - note.trust
      - note.updated
  - type: table
    name: Órfãs
    filters:
      and:
        - 'file.backlinks.length == 0'
        - 'file.links.length == 0'
        - not:
            - file.inFolder("raw")
            - file.name.contains(".conflict-")
    order:
      - file.name
      - note.type
      - file.mtime
`;

const DASHBOARDS: readonly DashboardFile[] = [
  {
    path: `${OBSIDIAN_DASHBOARDS_DIR}/memorias.base`,
    title: 'Memórias',
    description: 'memórias ativas por tipo e escopo',
    content: MEMORIES,
  },
  {
    path: `${OBSIDIAN_DASHBOARDS_DIR}/revisar.base`,
    title: 'Revisar',
    description: 'confiança baixa, sem confirmação há 180 dias e notas editadas por agente',
    content: REVIEW,
  },
  {
    path: `${OBSIDIAN_DASHBOARDS_DIR}/decisoes.base`,
    title: 'Decisões',
    description: 'decisões vigentes, vencidas e substituídas',
    content: DECISIONS,
  },
  {
    path: `${OBSIDIAN_DASHBOARDS_DIR}/fatos.base`,
    title: 'Fatos',
    description: 'fatos vigentes, vencidos e substituídos',
    content: FACTS,
  },
  {
    path: `${OBSIDIAN_DASHBOARDS_DIR}/saude.base`,
    title: 'Saúde',
    description: 'conflitos de sync pendentes, notas sem fonte, editadas por agente e órfãs',
    content: HEALTH,
  },
];

/** Os painéis, ordenados por caminho. Função pura: sempre os mesmos bytes. */
export function dashboardFiles(): DashboardFile[] {
  return [...DASHBOARDS].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** SHA-256 em hexadecimal de um texto, com as quebras de linha normalizadas para LF (o git no Windows pode pôr CRLF). */
export function contentHash(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/**
 * Conteúdos que versões anteriores do Cabeção geraram para cada painel (hash do texto). Um painel igual a um deles
 * nunca foi editado pelo usuário e pode ser trocado pela versão atual; qualquer outro conteúdo é do usuário e fica.
 * Vazio enquanto só existe a primeira versão.
 */
export const PREVIOUS_DASHBOARD_HASHES: Readonly<Record<string, readonly string[]>> = {};
