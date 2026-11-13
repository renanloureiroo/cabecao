// O que a varredura deriva do conjunto das notas, depois de gravar cada uma e resolver os links (marco 3):
//
// - `notes.superseded_on`: a data em que outra nota passou a substituir esta, pelo encadeamento `supersedes` /
//   `superseded_by` em qualquer um dos dois lados (o spike 12 recomenda: "o servidor deriva `valid_until` a partir
//   de `supersedes`; o agente só precisa escrever o link"). É a menor data entre as notas que a substituem
//   (`valid_from`, senão `created`). Entra na validade junto com `valid_until` (vale a mais cedo das duas).
// - os nomes das notas (`names`) e as menções sem link (`db/mentions.ts`).
import type { MentionRefreshSummary } from './mentions.ts';
import { refreshMentions } from './mentions.ts';
import type { DatabaseSync } from './sqlite.ts';

/** Recalcula `notes.superseded_on` de todas as notas (uma consulta só; as arestas `supersedes` são poucas). */
export function refreshSupersededOn(db: DatabaseSync): void {
  db.exec(`update notes set superseded_on = null where superseded_on is not null`);
  // Uma regra do usuário (`type: rule` ou em memory/rules/) só é substituída por outra regra do usuário
  // (`origin: human` em memory/rules/): senão, um agente venceria a regra (e a tiraria do `recall`) só escrevendo
  // `supersedes: [[regra]]` numa nota dele.
  db.exec(`
    with sup(old, d, newer_origin, newer_path) as (
      select e.dst_note, coalesce(s.valid_from, s.created), s.origin, s.path
      from edges e join notes s on s.id = e.src_note
      where e.origin = 'supersedes' and e.type = 'supersedes' and e.dst_note is not null
        and e.dst_note <> e.src_note and s.conflict_of is null
      union all
      select e.src_note, coalesce(t.valid_from, t.created), t.origin, t.path
      from edges e join notes t on t.id = e.dst_note
      where e.origin = 'supersedes' and e.type = 'superseded_by'
        and e.dst_note <> e.src_note and t.conflict_of is null
    ),
    allowed(old, d) as (
      select sup.old, sup.d from sup join notes o on o.id = sup.old
      where sup.d is not null
        and (not (coalesce(lower(trim(o.type)), '') = 'rule' or lower(o.path) like 'memory/rules/%')
          or (sup.newer_origin = 'human' and lower(sup.newer_path) like 'memory/rules/%'))
    )
    update notes set superseded_on = (select min(substr(allowed.d, 1, 10)) from allowed where allowed.old = notes.id)
    where id in (select old from allowed)`);
}

export interface DerivedInput {
  readonly touched: ReadonlySet<string>;
  readonly relinked: ReadonlySet<string>;
}

/** Atualiza tudo o que é derivado. Chamar dentro da transação da varredura, quando algo mudou. */
export function refreshDerived(db: DatabaseSync, input: DerivedInput): MentionRefreshSummary {
  refreshSupersededOn(db);
  return refreshMentions(db, input);
}
