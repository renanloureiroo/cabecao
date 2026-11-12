# 12 · Padrão de commits do cérebro

Todo commit que o Cabeção faz no repositório do cérebro segue este formato. É ele que torna possível auditar e desfazer por operação e por sessão.

> Este documento trata dos commits **no repositório do seu cérebro**. Os commits do código do projeto seguem [Conventional Commits](https://www.conventionalcommits.org/pt-br/) comuns (`feat`, `fix`, `docs`...).

## Formato

```
<ação>(<tipo da nota>): <título da nota>

<corpo opcional>

Cabecao-Op: 01JD3K8Y6Z9W2T4N5P7Q8R0S1V
Cabecao-Session: 01JD3K7M2A8B4C6D9E1F3G5H7J
Cabecao-Machine: macbook
Cabecao-Client: claude-code
```

### Ações

| Ação | Quando |
|---|---|
| `add` | Nota nova |
| `update` | Nota existente alterada |
| `supersede` | Nota nova que substitui outra |
| `archive` | `forget` |
| `ingest` | Fonte registrada em `raw/` |
| `edit` | Mudanças feitas fora do Cabeção (Obsidian, editor) |
| `maint` | Manutenção: `maint(lint)`, `maint(consolidate)`, `maint(migrate)` |
| `sync` | Integração entre máquinas: `sync`, `sync(conflict)` |
| `revert` | `undo` |
| `index` | Só na branch de índice |

O **escopo** é o tipo da nota (`gotcha`, `decision`, `fact`, `rule`...). O **assunto** é o título da nota, no idioma do seu cérebro, depois de passar pelo scanner de segredos.

### Rodapés

| Rodapé | Conteúdo |
|---|---|
| `Cabecao-Op` | ULID da operação. Embute o instante em **milissegundos** e ordena cronologicamente |
| `Cabecao-Session` | ULID da sessão do agente (o `session_handle`). Ausente em edições manuais |
| `Cabecao-Machine` | Nome da máquina, definido no `init` |
| `Cabecao-Client` | Quem gravou: `claude-code`, `claude-desktop`, `codex`, `cli`, `manual` |
| `Cabecao-Reverts` | Em commits `revert`: a operação desfeita |

## Data, hora e milissegundos

O git já guarda a data de cada commit, com precisão de segundos. Os milissegundos vêm do `Cabecao-Op`, e por isso não aparecem no assunto.

## Granularidade

- **Um commit por operação de escrita**, feito localmente na hora.
- O envio ao remoto acontece só no sync.
- Uma operação que toca várias notas (uma ingestão, uma consolidação) é **um** commit.

## Exemplos

```
add(gotcha): testes de integração falham sem limpar o banco
supersede(decision): usar SQS para filas
ingest(source): artigo sobre arquitetura hexagonal
edit(manual): 3 notas alteradas
maint(consolidate): semana 46, 4 fatos promovidos e 2 duplicatas fundidas
sync(conflict): "Deploy em produção" mantida em duas versões
revert: add(gotcha): testes de integração falham sem limpar o banco
index: geração 3, +120 vetores
```

## Consultas úteis

```bash
git log --grep "Cabecao-Session: 01JD3K7M"        # tudo de uma sessão
git log --grep "Cabecao-Client: claude-desktop"   # tudo de um cliente
git log --grep "^maint"                           # manutenções
```

## Autoria

O autor é a sua identidade do git. O Cabeção **não** acrescenta linhas de coautoria nem de atribuição a IA. `Cabecao-Client` registra de qual programa veio a mudança, para auditoria.

## Detalhes de implementação

- Os commits automáticos usam `--no-verify`, para não depender de hooks do seu git.
- Commits assinados com senha podem travar um processo sem terminal. O `doctor` detecta `commit.gpgsign` e avisa; a compatibilidade ainda não foi testada.
