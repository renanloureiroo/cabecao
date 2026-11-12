# Spike 10 — Resultados: protocolo MCP 2026-07-28 + compatibilidade 2025

Executado em 2026-11-12, macOS, Node v24.21.0. Tudo abaixo foi rodado; a saída real está em [`evidence/`](./evidence).
121 verificações automatizadas passam (`npm test`: 46 + 10 + 57 + 8), mais 5 cenários com o Claude Code real.

## Veredito por pergunta

| # | Pergunta | Veredito |
| --- | --- | --- |
| 1 | SDK v2 publicado e estável | **PROVADO** (com ressalva: `ext-tasks` é 0.x) |
| 2 | `serveStdio` atende cliente 2025 e 2026 | **PROVADO** |
| 3 | HTTP stateless nas duas eras + Bearer + Origin/Host | **PROVADO** |
| 4 | MRTR `inputRequired.elicit` + shim legacy + fallback `confirm_token` | **PROVADO** nos clientes SDK; **PARCIAL** como estratégia única (ver P4) |
| 5 | Tasks na extensão nova | **PARCIAL**: funciona, mas o servidor é escrito à mão e o Claude Code não usa |
| 6 | Resources, template, prompts, `instructions`, cache hints | **PROVADO** |
| 7 | `session_handle` como argumento; sem sessão de transporte | **PROVADO** |
| 8 | Claude Code real | **PROVADO** para tools / structuredContent / resources / MRTR; **DERRUBADO** para Tasks |
| 9 | Cold start e overhead do SDK | **PROVADO** (medido) |
| 10 | MCP Apps (`io.modelcontextprotocol/ui`) | **PROVADO** para registro + listagem + fallback textual; renderização em host não testada |

## Versões exatas

| Pacote | Versão instalada | Observação |
| --- | --- | --- |
| `@modelcontextprotocol/server` | 2.4.0 | `latest`; 2.0.0 estável saiu em 2026-07-27, 2.4.0 em 2026-10-23 |
| `@modelcontextprotocol/client` | 2.4.0 | `latest` |
| `@modelcontextprotocol/core` | 2.4.0 | dependência transitiva de server/client |
| `@modelcontextprotocol/node` | 2.1.2 | `toNodeHandler` para `node:http` |
| `@modelcontextprotocol/ext-apps` | 2.0.4 | `latest`; a 2.1.0 existe no registry mas não está marcada `latest` |
| `@modelcontextprotocol/ext-tasks` | 0.2.3 | **só cliente**, pré-1.0 |
| `@modelcontextprotocol/sdk` (v1) | 1.32.2 | usado só como baseline da alternativa |
| `zod` | 4.6.7 | o SDK v2 exige `^4.2.0` |
| Claude Code | 2.1.322 | cliente real |

---

## P1 — Pacotes e estabilidade: PROVADO

`npm view` mostra `latest` = 2.4.0 para server/client/core, sem tag alpha/beta. Houve 9 pré-releases antes da 2.0.0; desde então cinco releases estáveis em três meses e meio (2.1.0, 2.2.0, 2.3.0, 2.3.1, 2.4.0).

Ressalvas:

- O SDK v2 não tem suporte de servidor a Tasks; a camada experimental da v1 foi removida (ver P5).
- `@modelcontextprotocol/ext-tasks` é 0.2.3, cobre só o lado cliente.
- Os pacotes se dividiram: não existe mais um `@modelcontextprotocol/sdk` v2. Transportes stdio ficam no subpath `/stdio`.

## P2 — `serveStdio` dual-era: PROVADO

Evidência: `evidence/01-stdio.txt` (46/46).

| Cliente SDK | Primeiro método visto pelo servidor | Versão negociada |
| --- | --- | --- |
| `mode: 'legacy'` | `initialize` | 2025-11-25 |
| `mode: 'auto'` | `server/discover` | 2026-07-28 |
| `mode: { pin: '2026-07-28' }` | `server/discover` | 2026-07-28 |

Nas três combinações passaram: `tools/list` com `inputSchema` + `outputSchema` derivados do Zod v4, annotations `readOnlyHint` / `destructiveHint`, `structuredContent` validado contra o `outputSchema`, e rejeição de input inválido como `isError: true`.

`legacy: 'reject'` recusa o cliente 2025 com `Unsupported protocol version: 2025-11-25`.

Recorte de `src/build-server.ts` + `src/server.ts` (a versão integral é a que roda nos testes):

```ts
import { McpServer, type McpRequestContext } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

function buildServer(ctx: McpRequestContext): McpServer {   // ctx.era: 'legacy' | 'modern'
    const server = new McpServer({ name: 'cabecao-poc', version: '0.0.1' }, { instructions: '...' });
    server.registerTool(
        'search',
        {
            description: 'Busca substring nas paginas.',
            inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(50).optional() }),
            outputSchema: z.object({ hits: z.array(z.object({ path: z.string(), snippet: z.string() })), total: z.number().int() }),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        },
        async ({ query, limit }) => {
            const out = { hits: [], total: 0 };
            return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
        }
    );
    return server;
}

serveStdio(buildServer);   // dual-era por conexao; { legacy: 'reject' } recusa 2025
console.error('pronto');   // stdout e o canal JSON-RPC: log so no stderr
```

Surpresas:

- **O cliente SDK em `auto` ou `pin` sobe o servidor stdio duas vezes.** A sondagem `server/discover` roda num processo irmão descartável; o processo real nunca vê o `server/discover`. O trace mostra 2 PIDs. Custo medido: connect + 1 chamada ≈ 210 ms contra ≈ 110 ms em legacy. Consequência para o Cabeção: o boot do servidor não pode ter efeito colateral (lock no vault, migração, escrita em git) antes da primeira requisição real.
- O Claude Code **não** faz isso: sonda no mesmo processo (ver P8).
- Um `McpServer` conectado direto num `StdioServerTransport` continua falando só 2025. Dual-era exige `serveStdio`.

## P3 — HTTP stateless + Bearer + Origin/Host: PROVADO

Evidência: `evidence/03-http.txt` (57/57), `evidence/claude-code-http.txt`.

O mesmo factory, servido por `createMcpHandler`, passou a suíte inteira com cliente legacy, auto e pin.

| Requisição crua | Resposta |
| --- | --- |
| sem `Authorization` | 401 + `WWW-Authenticate: Bearer error="invalid_token"` |
| token errado | 401 |
| `Host: evil.example.com` | 403 `Invalid Host` |
| `Origin: https://evil.example.com` | 403 `Invalid Origin` |
| Origin loopback + token certo | 200, sem header `Mcp-Session-Id` |

O cliente SDK sem token falha no connect com `CLIENT_HTTP_AUTHENTICATION`; um 401 não vira fallback de era.

Código que rodou (`src/http.ts`):

```ts
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
    createMcpHandler, hostHeaderValidationResponse, localhostAllowedHostnames, localhostAllowedOrigins,
    OAuthError, OAuthErrorCode, originValidationResponse, requireBearerAuth
} from '@modelcontextprotocol/server';
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const handler = createMcpHandler(buildServer);            // { legacy: 'reject' } recusa 2025
const gate = requireBearerAuth({
    verifier: {
        async verifyAccessToken(presented) {
            const a = Buffer.from(presented), b = Buffer.from(process.env.POC_TOKEN!);
            if (a.length !== b.length || !timingSafeEqual(a, b)) throw new OAuthError(OAuthErrorCode.InvalidToken, 'invalid token');
            // expiresAt e obrigatorio: o helper rejeita token sem expiracao
            return { token: presented, clientId: 'local', scopes: ['mcp'], expiresAt: Math.floor(Date.now() / 1000) + 3600 };
        }
    }
});
const guarded = {
    async fetch(request: Request, opts?: { parsedBody?: unknown }) {
        const badHost = hostHeaderValidationResponse(request, localhostAllowedHostnames());
        if (badHost) return badHost;
        const badOrigin = originValidationResponse(request, localhostAllowedOrigins());
        if (badOrigin) return badOrigin;
        const auth = await gate(request);
        if (auth instanceof Response) return auth;
        return handler.fetch(request, { ...opts, authInfo: auth });
    }
};
const node = toNodeHandler(guarded);
createServer((req, res) => void node(req, res)).listen(3917, '127.0.0.1');
```

Limitações do HTTP stateless para clientes 2025:

- Não existe canal servidor→cliente. Elicitação via shim não funciona; a tool tem que cair no fallback (ver P4).
- Não testei OAuth de verdade, só Bearer estático.

## P4 — MRTR, shim legacy e fallback `confirm_token`: PROVADO / PARCIAL

Evidência: `evidence/02-mrtr-stdio.txt`, `evidence/03-http.txt`, `evidence/claude-code-forget.txt`, `evidence/claude-code-legacy.txt`.

| Cenário | Cliente declara elicitation | Resultado |
| --- | --- | --- |
| stdio 2026 | sim, aceita | apagado via MRTR (2 `tools/call`) |
| stdio 2026 | sim, recusa | `declined`, página intacta |
| stdio 2025 (shim) | sim, aceita | apagado; o SDK emitiu `elicitation/create` real |
| HTTP 2026 | sim, aceita | apagado via MRTR |
| HTTP 2025 stateless | sim | shim não tem como perguntar; cai no `confirm_token` |
| qualquer | não | `confirmation_required` + token; 2ª chamada apaga |
| Claude Code `-p` (headless) | sim | responde `cancel` sozinho; cai no `confirm_token` |

No fio, era 2026:

```
C->S tools/call id=0
S->C resultType=input_required inputRequests={"confirm":{"method":"elicitation/create",...}}
C->S tools/call id=1 inputResponses={"confirm":{"action":"accept","content":{"confirm":true}}}
S->C resultType=complete {"status":"deleted","via":"elicitation"}
```

Era 2025, mesmo handler:

```
C->S tools/call id=1
S->C elicitation/create id=0 "Apagar definitivamente tmp/rascunho.md?"
C->S (resposta id=0) {"action":"accept","content":{"confirm":true}}
S->C (resposta id=1) {"status":"deleted","via":"elicitation"}
```

O que acontece com MRTR puro quando o cliente não declara elicitation:

- Era 2026: erro de protocolo `-32021` (o `callTool` do cliente lança exceção).
- Era 2025: resultado `isError: true` com texto explicativo.
- Nos dois casos nada é apagado, mas o agente fica sem caminho para concluir.

**Qual estratégia é mais robusta: híbrida, com o token como base.** MRTR sozinho falha em três situações reais (cliente sem elicitation, HTTP 2025 stateless, host headless). O token sozinho funciona em todas, mas perde o prompt nativo ao usuário. A ordem que rodou (recorte abreviado de `src/build-server.ts`; `needsToken`, `declined` e `deletePage` resumem os retornos):

```ts
async ({ path, confirm_token }, ctx): Promise<CallToolResult | InputRequiredResult> => {
    // 1) token presente: valida e executa (funciona em qualquer cliente)
    if (confirm_token) {
        const v = verifyConfirmToken(confirm_token, 'forget', path);
        if (!v.ok) return { isError: true, content: [{ type: 'text', text: `confirm_token invalido: ${v.reason}` }] };
        return deletePage(path);
    }
    // 2) MRTR so se o cliente declarou elicitation (envelope em 2026, initialize em 2025)
    const env = ctx.mcpReq.envelope as Record<string, any> | undefined;
    const caps = env?.[CLIENT_CAPABILITIES_META_KEY] ?? server.server.getClientCapabilities();
    if (caps?.elicitation) {
        const view = inputResponse(ctx.mcpReq.inputResponses, 'confirm');
        if (view.kind === 'missing') {
            return inputRequired({
                inputRequests: {
                    confirm: inputRequired.elicit({
                        message: `Apagar definitivamente ${path}?`,
                        requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] }
                    })
                }
            });
        }
        // cancel = ninguem respondeu (host headless); nao e recusa explicita
        if (view.kind === 'elicit' && view.action === 'cancel') return needsToken(path);
        const ok = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', z.object({ confirm: z.boolean() }));
        if (ok?.confirm !== true) return declined(path);
        return deletePage(path);
    }
    // 3) sem elicitation: preview + token
    return needsToken(path);
}
```

O `confirm_token` é stateless: HMAC-SHA256 sobre ação, path, hash do conteúdo e expiração. Testado: token adulterado (`bad_signature`), token de outro alvo (`token_for_other_target`).

Ressalvas honestas:

- **O token não é barreira humana.** O modelo pode chamar duas vezes sozinho. Ele garante intenção em dois passos e amarra a ação ao conteúdo que foi mostrado no preview. A barreira humana real é a elicitação ou o prompt de permissão do host (`destructiveHint`).
- O ramo `cancel` foi exercitado só pelo Claude Code real, não por teste automatizado.
- Não testei `requestState` nem `createRequestStateCodec`; o fluxo aqui tem uma rodada só.
- Expiração do token e mudança da página entre preview e confirmação estão implementadas mas não têm teste.

## P5 — Tasks: PARCIAL

Evidência: `evidence/04-tasks.txt` (8/8), `evidence/claude-code-forcetask.txt`.

O que existe de fato:

- O SDK v2 **não tem API de servidor para Tasks**. Aceita só handlers de `tasks/get` e `tasks/cancel` registrados com schema explícito, e deixa passar `resultType: 'task'` em `tools/call`.
- O store de tasks, o trabalho em background, o TTL e o cancelamento são código nosso.
- `@modelcontextprotocol/ext-tasks` 0.2.3 é só cliente.

Como registrar (recorte abreviado de `src/build-server.ts`; `runSync`, `createTaskAndStartWork`, `findTask` resumem o código real):

```ts
const TASKS_EXT = 'io.modelcontextprotocol/tasks';
server.server.registerCapabilities({ extensions: { [TASKS_EXT]: {} } });

server.registerTool('reindex', { inputSchema: z.object({ steps: z.number().int().default(5) }) }, async ({ steps }, ctx) => {
    const env = ctx.mcpReq.envelope as Record<string, any> | undefined;
    const caps = env?.[CLIENT_CAPABILITIES_META_KEY];
    const clientHasTasks = reqCtx.era === 'modern' && caps?.extensions?.[TASKS_EXT] !== undefined;
    if (!clientHasTasks) return runSync(steps);          // a spec proibe devolver Task a quem nao declarou
    const rec = createTaskAndStartWork(steps);           // precisa existir antes de responder
    return { resultType: 'task', taskId: rec.taskId, status: 'working', createdAt, lastUpdatedAt, ttlMs: 600_000, pollIntervalMs: 100 } as unknown as CallToolResult;
});

const params = z.object({ taskId: z.string() });
const result = z.looseObject({});
server.server.setRequestHandler('tasks/get', { params, result }, async ({ taskId }) => publicTask(findTask(taskId)));
server.server.setRequestHandler('tasks/cancel', { params, result }, async ({ taskId }) => { cancel(taskId); return {}; });
```

| Cliente | Comportamento |
| --- | --- |
| JSON-RPC cru com a extensão no envelope | `CreateTaskResult`, `tasks/get` até `completed`, `tasks/cancel` funciona |
| `ext-tasks` (`createTaskSessionFromClient`) sobre HTTP | `tools/call` → task → 2× `tasks/get` → `settle()` devolve o resultado |
| mesmo cliente sem a extensão | resultado síncrono, `resultType: complete` |
| cliente SDK v2 puro declarando a extensão | `callTool` lança `UNSUPPORTED_RESULT_TYPE` |
| cliente 2025 | síncrono |
| Claude Code 2.1.322 | síncrono; forçando Task, erro `Unsupported result type 'task'` |

Armadilhas encontradas:

- O `result` embutido numa task `completed` precisa carregar `resultType: 'complete'`. O SDK só carimba o resultado de topo. Sem isso o `ext-tasks` rejeita com `Protocol value failed schema validation`.
- Declarar a extensão no cliente SDK v2 puro **quebra** a chamada: o servidor responde Task e o cliente não sabe ler. Só declare via `ext-tasks`.
- `ext-tasks` contra servidor 2026 exige `rawDispatch` + `v2RequestFraming`; sem eles a criação da sessão lança `TypeError`. O host tem que fornecer seu próprio despachante JSON-RPC cru.
- O SDK acrescenta `content: []` ao `CreateTaskResult` no fio. O `ext-tasks` aceitou.

Conclusão: execução síncrona é obrigatória como caminho padrão. Tasks é um extra opcional, hoje sem cliente relevante.

Não testado: tasks com `input_required` (`tasks/update`), `notifications/tasks`, persistência entre reinícios, e Tasks no formato 2025-11-25.

## P6 — Resources, prompts, instructions, cache hints: PROVADO

Evidência: `evidence/01-stdio.txt`, `evidence/03-http.txt`.

Passou nas duas eras e nos dois transportes:

- recurso estático `cabecao://index`
- template `cabecao://page/{+path}` com `list` enumerando instâncias; leitura de `cabecao://page/notes/mcp.md`
- `prompts/list` + `prompts/get` com `argsSchema` Zod
- `instructions`: chega pelo `initialize` em 2025 e pelo `server/discover` em 2026

Cache hints, lidos do trace em 2026:

| Operação | Configuração | No fio |
| --- | --- | --- |
| `server/discover` | `cacheHints` do servidor | `ttlMs=300000`, `public` |
| `tools/list` | `cacheHints` do servidor | `ttlMs=60000`, `public` |
| `resources/list` | `cacheHints` do servidor | `ttlMs=5000`, `private` |
| `resources/read` | `cacheHint` do recurso | `ttlMs=2000`, `private` |

Em 2025 as respostas não carregam `ttlMs`, `cacheScope` nem `resultType`. Sem configuração o SDK emite `ttlMs: 0` / `private`.

```ts
new McpServer(info, { instructions: '...', cacheHints: { 'tools/list': { ttlMs: 60_000, cacheScope: 'public' } } });
server.registerResource('page', new ResourceTemplate('cabecao://page/{+path}', { list: async () => ({ resources }) }),
    { mimeType: 'text/markdown' }, async (uri, { path }) => ({ contents: [{ uri: uri.href, text }] }));
```

Detalhes:

- Para caminhos com `/` o template precisa de `{+path}`. O enunciado pedia `{path}`; com `/` no valor só a forma `{+path}` foi testada.
- Recurso inexistente chega ao cliente como `-32602`, mesmo eu lançando `-32002`.
- Não testei `subscriptions/listen` entregando `list_changed`, nem o cache do lado cliente.

## P7 — Estado sem sessão: PROVADO

Evidência: linhas `session_handle como argumento` em `evidence/01-stdio.txt` e `evidence/03-http.txt`.

- `ctx.sessionId` é `undefined` em todas as combinações (`transport_session_id=null`).
- No HTTP nenhuma resposta traz `Mcp-Session-Id`, e o Claude Code não envia esse header.
- No HTTP cada requisição recebe uma instância nova do servidor: `session_start` rodou na instância #18 e `session_note` na #20, e as notas persistiram. O estado mora no processo, indexado pelo handle.
- No stdio a instância é uma por conexão, então estado em closure do factory funcionaria lá e quebraria no HTTP. Não usar.
- O Claude Code real encadeou `session_start` → `session_note` passando o handle sozinho.

Padrão viável: `session_start` devolve um handle opaco; as outras tools o recebem como argumento; handle desconhecido devolve `isError`.

## P8 — Claude Code real: PROVADO, exceto Tasks

Evidência: `evidence/claude-code-*.txt`. Versão: **2.1.322**.

| Aspecto | Observado |
| --- | --- |
| Lista e chama tools | sim; as 8 tools aparecem como `mcp__cabecao-poc__*` |
| Era negociada (stdio e HTTP) | **2026-07-28**; primeiro método `server/discover` |
| Contra servidor só-2025 | recebe `-32601` na sondagem e segue com `initialize` (2025-11-25) |
| Sondagem | no mesmo processo; um único spawn do servidor |
| Capabilities na abertura | `roots`, `elicitation: {form, url}`, `extensions: {tasks}` |
| Capabilities em `tools/call` | `roots`, `elicitation` — **sem** a extensão tasks |
| MRTR | sim, nas duas eras; em `-p` responde `{"action":"cancel"}` em ~35 ms |
| Tasks | não; `reindex` roda síncrono |
| structuredContent | sim, e **substitui** o texto |
| Resources | sim, via `ReadMcpResourceTool` / `ListMcpResourcesTool`; leu o template |
| MCP Apps | recebeu o fallback textual; não renderizou UI |
| `subscriptions/listen` | abre logo após o discover; o servidor confirma |
| HTTP + Bearer por header de config | funciona; sem `Mcp-Session-Id` |

Surpresas que mudam o desenho:

- **Com `structuredContent` presente, o modelo recebe o JSON dele, não o `content` textual.** No teste, o texto "CONFIRMACAO NECESSARIA..." não chegou ao modelo; chegou o objeto. Instruções de próximo passo têm que estar dentro do `structuredContent` (campo `next_step`). Com isso o Claude Code completou o fluxo de dois passos sozinho.
- **Modo headless nunca confirma por elicitação.** Sem o tratamento de `cancel`, `forget` seria impossível em `claude -p`.
- **A era 2026 no Claude Code vem de feature flag.** O log de debug diz `mcp runtime arm: v2 (source: growthbook)`. Outra conta ou versão pode cair em 2025; o servidor tem que servir as duas.
- A primeira mensagem chegou entre 83 e 133 ms depois do início do processo servidor.

Observação não explicada: uma configuração cujo primeiro run teve a sondagem sem resposta (bug de instrumentação meu, já corrigido) passou a receber `initialize` direto nos runs seguintes, sem sondagem. Em configurações limpas o Claude Code sondou em toda conexão e detectou na hora a troca de servidor só-2025 para dual-era. Parece cache de veredito "legacy" após timeout, mas não localizei onde fica nem provei a causa.

Não testado: Claude Code interativo (prompt de elicitação na TUI, prompt de permissão para `destructiveHint`), Claude Desktop, outros hosts.

## P9 — Cold start e overhead: PROVADO

Evidência: `evidence/bench-coldstart.txt`, `evidence/bench-percall.txt`. Spawn até a primeira resposta, n=25, medianas.

| Variante | 1ª resposta | 1ª `tools/call` |
| --- | --- | --- |
| piso: `node -e 0` | 28 ms | — |
| sem SDK, JSON-RPC à mão | 30 ms | 30 ms |
| SDK mínimo (1 tool), `.ts` direto | 103 ms | 104 ms |
| SDK mínimo, bundle esbuild | 57 ms | 57 ms |
| PoC completa (8 tools + ext-apps), `.ts` direto | 101–105 ms | 103–107 ms |
| PoC completa, bundle esbuild | 70 ms | 72 ms |
| PoC completa, bundle + `NODE_COMPILE_CACHE` | 72 ms | 74 ms |

- Overhead do SDK + Zod no boot: ~27 ms empacotado, ~70 ms sem bundle. O bundle tem 1,07 MB.
- Era 2025 e 2026 custam o mesmo no boot.
- `NODE_COMPILE_CACHE` não ajudou.
- As medidas oscilam com a carga da máquina; entre três execuções a PoC sem bundle variou de 100 a 150 ms.

Por chamada, processo quente, n=300:

| Transporte | mediana | p95 |
| --- | --- | --- |
| stdio 2025 | 0,10 ms | 0,30 ms |
| stdio 2026 | 0,16 ms | 0,59 ms |
| HTTP stateless 2026 (factory por requisição) | 0,84 ms | 2,21 ms |
| HTTP stateless 2025 | 1,66 ms | 8,69 ms |

O factory por requisição custa menos de 1 ms com 8 tools. Não medi com índice real carregado; o que for pesado tem que ficar fora do factory.

## P10 — MCP Apps: PROVADO (registro, listagem, fallback)

Evidência: linhas `MCP Apps` em `evidence/01-stdio.txt` e `evidence/03-http.txt`.

Pacote atual: `@modelcontextprotocol/ext-apps` 2.0.4, import `@modelcontextprotocol/ext-apps/server`. Funciona com o SDK v2 (peer `^2.0.0`).

```ts
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';

const uiUri = 'ui://cabecao/page-card.html';
registerAppTool(server, 'show_page_card',
    { description: '...', inputSchema: z.object({ path: z.string() }), _meta: { ui: { resourceUri: uiUri } } },
    async ({ path }) => ({ content: [{ type: 'text', text: `${path}\n\n${body}` }] }));   // fallback textual
registerAppResource(server, 'page-card', uiUri, { mimeType: RESOURCE_MIME_TYPE },
    async () => ({ contents: [{ uri: uiUri, mimeType: RESOURCE_MIME_TYPE, text: '<!doctype html>...' }] }));
```

- `tools/list` traz `_meta: {"ui":{"resourceUri":"ui://..."},"ui/resourceUri":"ui://..."}` (o helper grava também a chave antiga).
- O recurso lista e lê com mime `text/html;profile=mcp-app`.
- Nas duas eras, stdio e HTTP.
- O Claude Code CLI recebeu só o texto.

Não testado: renderização em host, ponte `postMessage`, CSP.

---

## Alternativas avaliadas

Evidência: `evidence/v1-vs-v2.txt`.

| Opção | Resultado | Avaliação |
| --- | --- | --- |
| SDK v2 2.4.0 com `serveStdio` / `createMcpHandler` | atende legacy, auto e pin | **recomendada** |
| SDK v1 1.32.2 | atende legacy e auto (cai para 2025); `pin 2026` falha com `ERA_NEGOTIATION_FAILED` | funciona hoje, sem caminho para 2026 |
| Dual-era implementado à mão | não implementei | desnecessário: o v2 não mostrou instabilidade nos 121 testes |

O v2 não se mostrou instável. O único defeito que apareceu durante o spike foi meu (um wrapper de instrumentação em `transport.onmessage` que entrou em recursão no modo só-2025).

## Recomendação de arquitetura

1. **SDK v2** (`@modelcontextprotocol/server` 2.4.0, `zod` 4), versões fixadas.
2. **Um factory `buildServer(ctx)` sem estado**, servido por `serveStdio` (padrão) e por `createMcpHandler` (opcional). Estado em módulo ou serviço de processo, nunca em closure do factory.
3. **Boot sem efeitos colaterais.** Clientes SDK sobem o processo duas vezes para sondar.
4. **Dual-era ligado** (`legacy: 'serve'` / `'stateless'`). O Claude Code depende de feature flag para falar 2026.
5. **Tools destrutivas com confirmação híbrida**: `confirm_token` como base, MRTR quando o cliente declara elicitation, `cancel` tratado como "sem resposta".
6. **Todo resultado com `outputSchema` é autoexplicativo no `structuredContent`**, incluindo o próximo passo.
7. **Sessão de aplicação por `session_handle` em argumento.**
8. **Operações longas síncronas por padrão**, com progresso e cancelamento. Tasks fica fora da v1 do plano, ou entra atrás da checagem de capability por requisição.
9. **HTTP só em 127.0.0.1**, com validação de Host, Origin e Bearer em tempo constante, nessa ordem.
10. **Distribuir como bundle único** (esbuild): ~70 ms de cold start contra ~100 ms.
11. **MCP Apps como extra**: registrar com `ext-apps`, sempre com fallback textual útil.

## O que NÃO usar

- `server.connect(new StdioServerTransport())` como entrada: fica preso em 2025.
- `ctx.sessionId`, `Mcp-Session-Id` ou qualquer estado de transporte.
- `ctx.mcpReq.elicitInput()` e demais APIs push: falham em requisições 2026. Use `inputRequired(...)`.
- MRTR sem checar a capability do cliente e sem fallback.
- `content` textual como único portador de instruções quando há `structuredContent`.
- Sampling, roots e logging como dependência: a spec 2026 os descontinua (não testei, só li).
- Tasks 2025-11-25 (`params.task`, `tasks/result`): removido do SDK v2.
- Declarar a extensão tasks num cliente SDK v2 puro.
- `log` no stdout do processo stdio.

## O que não foi testado

- Claude Code interativo, Claude Desktop e outros hosts reais.
- OAuth; só Bearer estático.
- `requestState` / fluxos MRTR de várias rodadas; elicitação em modo URL.
- Entrega de `list_changed` por `subscriptions/listen`; cache do lado cliente.
- Tasks com input, notificações de task, persistência de tasks.
- Renderização de MCP Apps.
- Windows e Linux; todas as medidas são de um Mac.
- Factory com carga real (índice, git).
