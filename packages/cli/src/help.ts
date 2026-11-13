// Exemplos e grupos da ajuda (`cabecao --help` e `cabecao <comando> --help`). Só metadados: o roteador avalia este
// arquivo em todo início. Todo comando de `commands.ts` precisa de ao menos um exemplo aqui (um teste confere), e um
// comando fora de `GROUPS` aparece no grupo "Outros".

/** Exemplos por comando, linhas completas de shell, do mais comum para o mais raro. */
export const EXAMPLES: Readonly<Record<string, readonly string[]>> = {
  init: [
    'cabecao init git@github.com:voce/cerebro.git',
    'cabecao init',
    'cabecao init https://gitlab.com/voce/cerebro.git --dir ~/notas',
  ],
  status: ['cabecao status', 'cabecao status --json'],
  doctor: ['cabecao doctor', 'cabecao doctor --offline'],
  sync: ['cabecao sync', 'cabecao sync --detach'],
  schedule: ['cabecao schedule on', 'cabecao schedule on --interval 60', 'cabecao schedule status'],
  ask: [
    'cabecao ask "que fila o Atlas usa hoje?"',
    'cabecao ask "quem liderava o Atlas?" --as-of 2026-03-01',
    'cabecao ask "o que decidimos sobre filas?" --show-context',
  ],
  llm: [
    'cabecao llm on',
    'cabecao llm on --provider gemini',
    'cabecao llm on --provider ollama --model llama3.2',
    'cabecao llm status',
    'cabecao llm test',
    'cabecao llm off',
    'cabecao llm policy --allow agent',
  ],
  search: [
    'cabecao search "fila de mensagens"',
    'cabecao search "quem lidera o atlas" --as-of 2026-03-01',
    'cabecao search pnpm --type preference',
  ],
  recall: ['cabecao recall "migrar os consumidores do atlas" --scope project:atlas'],
  graph: ['cabecao graph "Projeto Atlas"', 'cabecao graph "Projeto Atlas" --depth 2 --type uses'],
  facts: ['cabecao facts --subject "Projeto Atlas"', 'cabecao facts --predicate led_by --as-of 2026-01-15'],
  read: [
    'cabecao read memory/preferences/respostas-em-portugues.md',
    'cabecao read "wiki/entities/Projeto Atlas.md" --json',
  ],
  remember: [
    'cabecao remember --type preference "Prefiro respostas curtas, em tópicos"',
    'cabecao remember --type gotcha --title "Limpar o banco antes dos testes" --scope project:atlas < nota.md',
  ],
  write: ['cabecao write wiki/concepts/idempotencia.md --type concept --title Idempotência < texto.md'],
  patch: ['cabecao patch wiki/concepts/idempotencia.md --old "versão antiga" --new "versão nova"'],
  relate: ['cabecao relate "Projeto Atlas" uses SQS'],
  handoff: ['cabecao handoff --session <id> --done "migrei 2 consumidores" --next "migrar o faturamento"'],
  undo: ['cabecao undo', 'cabecao undo --list', 'cabecao undo --op 01M7AKWKSKNEWJ4XXPNDP69ZEV'],
  lint: ['cabecao lint', 'cabecao lint --rule broken_link --rule orphan_note'],
  ingest: [
    'cabecao ingest ~/Downloads/artigo.md --title "Filas gerenciadas"',
    'pbpaste | cabecao ingest - --title "Ata de hoje"',
  ],
  forget: ['cabecao forget memory/preferences/usar-tabs.md --reason "mudei de ideia"'],
  consolidate: ['cabecao consolidate', 'cabecao consolidate --finish <id>', 'cabecao consolidate --run --dry-run'],
  embeddings: ['cabecao embeddings status', 'cabecao embeddings on', 'cabecao embeddings off'],
  compact: ['cabecao compact', 'cabecao compact --prune'],
  eval: [
    'cabecao eval perguntas.jsonl',
    'cabecao eval perguntas.jsonl --alpha 0.4 --alpha 0.6',
    'cabecao eval --answers respostas.jsonl',
    'cabecao eval --answers respostas.jsonl --provider claude-code,openai',
  ],
  reindex: ['cabecao reindex', 'cabecao reindex --full'],
  obsidian: ['cabecao obsidian setup --dry-run', 'cabecao obsidian setup', 'cabecao obsidian clipper > clipper.json'],
  export: [
    'cabecao export canvas --node "Projeto Atlas"',
    'cabecao export canvas --scope project:atlas -o dashboards/atlas.canvas',
  ],
  upgrade: ['cabecao upgrade --dry-run', 'cabecao upgrade', 'cabecao upgrade --template --dry-run'],
  mcp: ['cabecao mcp --brain ~/cabecao'],
  'install-client': [
    'cabecao install-client --all',
    'cabecao install-client codex cursor',
    'cabecao install-client --print claude-desktop',
  ],
  'install-skills': [
    'cabecao install-skills',
    'cabecao install-skills codex --project',
    'cabecao install-skills --print',
    'cabecao install-skills --remove',
  ],
  uninstall: ['cabecao uninstall --dry-run', 'cabecao uninstall'],
};

/** Grupos da ajuda geral, na ordem em que aparecem. */
export const GROUPS: readonly { readonly title: string; readonly commands: readonly string[] }[] = [
  {
    title: 'Uso diário',
    commands: ['status', 'sync', 'search', 'ask', 'recall', 'read', 'remember', 'handoff', 'undo'],
  },
  {
    title: 'Configuração',
    commands: [
      'init',
      'doctor',
      'install-client',
      'install-skills',
      'schedule',
      'embeddings',
      'llm',
      'obsidian',
      'upgrade',
      'uninstall',
    ],
  },
  {
    title: 'Notas e grafo',
    commands: ['write', 'patch', 'relate', 'graph', 'facts', 'ingest', 'export'],
  },
  {
    title: 'Manutenção',
    commands: ['lint', 'consolidate', 'forget', 'reindex', 'compact', 'eval', 'mcp'],
  },
];
