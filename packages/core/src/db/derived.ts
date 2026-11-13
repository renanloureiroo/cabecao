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
  db.exec(`
    with sup(old, d) as (
      select e.dst_note, coalesce(s.valid_from, s.created)
      from edges e join notes s on s.id = e.src_note
      where e.origin = 'supersedes' and e.type = 'supersedes' and e.dst_note is not null
        and e.dst_note <> e.src_note and s.conflict_of is null
      union all
      select e.src_note, coalesce(t.valid_from, t.created)
      from edges e join notes t on t.id = e.dst_note
      where e.origin = 'supersedes' and e.type = 'superseded_by'
        and e.dst_note <> e.src_note and t.conflict_of is null
    )
    update notes set superseded_on = (
      select min(substr(sup.d, 1, 10)) from sup where sup.old = notes.id and sup.d is not null
    )
    where id in (select old from sup where d is not null)`);
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
