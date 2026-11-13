# tronc-ts

The TypeScript chassis of the [Facile Studio](https://facile.studio) suite. It holds a kit that
gives a TypeScript app a remote MCP server, the conformance kit its tests run, and the client an
app uses to call Bulle for its users. It is the TypeScript counterpart of Go [`tronc/mcp`](https://github.com/FacileStudio/tronc/tree/main/mcp)
and keeps its names, its wire behaviour and its rules.

It is built on the official SDK, `@modelcontextprotocol/server` 2.4 (`createMcpHandler`), and on
`jose` for token checks. Nothing else.

## Install

bun installs it from a tag, from the repository root:

```sh
bun add github:FacileStudio/tronc-ts#v0.2.0
```

which writes `"@facile/tronc": "github:FacileStudio/tronc-ts#v0.2.0"` to `package.json`.

The package ships TypeScript source, like muse. It needs bun (or any bundler-style resolver) and
`moduleResolution: "Bundler"`.

## What the server does

- Serves MCP at the path of your resource URI, stateless, on spec 2026-07-28. Clients on the
  2025 spec get the SDK's stateless fallback.
- Answers 405 to GET, refuses a foreign `Origin` with 403, and lists tools sorted by name, cached
  privately for 10 minutes.
- Requires a Registre access token bound to the resource (RFC 8707). A missing or bad token gets
  401 with a `WWW-Authenticate` challenge naming the metadata.
- Serves the RFC 9728 metadata at `/.well-known/oauth-protected-resource/<path>` and at the bare
  well-known path.
- Scopes are `<app>.read` and `<app>.write`. A write grant implies read. A read-only token that
  calls a write tool gets 403 `insufficient_scope` naming the write scope, so the client can ask
  for more. A read-only server sets the read scope alone.
- Limits each person to 120 calls a minute with a burst of 120, like Go `NewApp`. A token that
  names no person gets its own bucket. A refusal is a plain-text 429 `rate limit exceeded` with
  `Retry-After`, and a foreign `Origin` a plain-text 403, as Go answers both.
- Writes one audit line per write call and per confirmation event, never the arguments.

## Mount it (Hono)

```ts
import { mount, newTool, registreVerifier } from '@facile/tronc/mcp';

const resource = 'https://glouton.facile.studio/mcp';
const verifier = await registreVerifier({
  issuer: 'https://sso.facile.studio',
  resource,
  scopePrefix: 'glouton',
  audience: 'glouton-client-id',
  resolveUser: async (claims) => findUserIdBySubject(claims.subject),
});

mount(app, {
  name: 'glouton',
  title: 'Glouton',
  version: APP_VERSION,
  resource,
  issuer: 'https://sso.facile.studio',
  verifier,
  tools: [searchLeads, saveDraft],
});
```

Mount it on the root app, outside any `/api` prefix and outside CSRF middleware. `mount` takes
any router with Hono's `all(path, handler)`. Without one, call `newServer(opts)` and route
`server.paths` to `server.fetch(request)`.

`registreVerifier` checks the RS256 signature against Registre's JWKS, `iss`, `exp`, `nbf`,
`iat` and the audience. The app's own client id (`audience`) is accepted only on a delegated
token, one that carries `act`: that is how Bulle's exchanged tokens reach the app today. Every
refusal is the same `invalid_token`. A failing `resolveUser` is a 500, not a refusal.

## Write a tool

```ts
const searchLeads = newTool<{ query: string }>({
  name: 'glouton_leads_search',
  title: 'Search leads',
  description: 'Finds leads by name, city or category. Returns ids for glouton_lead_get.',
  annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
}, async ({ query }, { caller }) => ({ leads: await leads.search(caller.userId, query) }));
```

- Names are `<app>_<verb>` or `<app>_<resource>_<verb>`. `newServer` refuses a tool without the
  prefix, a title, a description, all four annotations, or one that is read-only and destructive.
- Schemas are plain JSON Schema objects, or any Standard Schema with JSON output (zod 4).
- The handler returns its structured result. Throw `failure(err, hint)`, `invalid(...)` or
  `notFound(...)` for errors a model can act on. Any other error reaches the model as "the app
  could not finish this request" and goes to `onError`.
- `page.ts` has the Go helpers: `detailed`, `encodeCursor`, `decodeCursor`, `fitCount`,
  `encodedSize` and `clip`, to keep a result under about 25k tokens.

## Confirm sensitive actions

Sending, deleting and other irreversible writes go through `Confirmations`. When the client can
elicit on 2026-07-28, the tool returns an MRTR `input_required` question. Otherwise nothing runs:
the action waits as a pending action and the tool returns a link to confirm it in the app.

```ts
const confirmations = new Confirmations({
  store: new SqlPending((sql, params) => prisma.$queryRawUnsafe(sql, ...params)),
  key: process.env.MCP_CONFIRM_KEY!,
  confirmUrl: 'https://glouton.facile.studio/app/pending',
  kinds: { delete_lead: { tool: 'glouton_lead_delete', fingerprint, run } },
});

async ({ id }, req) => {
  if (retrying(req.ctx)) return { status: (await confirmations.resume(req, 'delete_lead')).status };
  const { result, outcome } = await confirmations.request(req, 'delete_lead', id, `Delete lead ${id}?`);
  return result ?? { status: outcome.status, confirm_url: outcome.confirmUrl };
};
```

- The question state is signed with HMAC-SHA256 and bound to the person, in Go's wire format.
- A claim is single use, whether it comes from the client or from the confirm page.
- `fingerprint` runs when asking and again before running. If the target changed in between, the
  action closes and nothing runs.
- `PENDING_SCHEMA` is the same `mcp_actions` table as Go. Run it with your migrations.
- `digest(...fields)` makes a fingerprint, byte for byte Go's `mcp.Digest`.
- An account erasure deletes the person's actions with `store.erase(userId)`, or with
  `erasePending(query, userId)` inside its own transaction.
- The confirm page calls `confirm`, `dismiss`, `open`, `state` and `link`. It must refuse a
  delegated token: an agent never confirms its own request.

## Test it

`@facile/tronc/mcp/mcptest` is the conformance kit, the counterpart of Go `mcptest`. It runs a
fake issuer, an in-memory pending store, and `run(config)`, which registers bun tests against
your live endpoint:

```ts
import { MemoryPending, newIssuer, run } from '@facile/tronc/mcp/mcptest';

const issuer = await newIssuer();
run({
  url: resource,
  token: (...scopes) => issuer.token(resource, 'person', ...(scopes.length ? scopes : ['glouton.read', 'glouton.write'])),
  confirm: [{ tool: 'glouton_lead_delete', setup: async () => ({ args: { id }, runs: () => deleted(id) }) }],
});
```

It checks the 401 challenge and the metadata, 405 on GET, the Origin guard, the annotations and
schemas, a stable sorted private tool list, the 403 write-scope challenge, and for each sensitive
tool: a link for clients that cannot elicit and for 2025 clients, a decline that runs nothing, an
accept that runs once and cannot be replayed, and a link id that cannot pass as a signed state.
`src/mcp/example.test.ts` is a complete example.

## Call Bulle

`@facile/tronc/bulle` is the counterpart of Go `tronc/bulle`. The token source returns the
person's token exchanged for audience `bulle`; `forget` drops a cached one after a 401.

```ts
import { Client, PlanRequired } from '@facile/tronc/bulle';

const target = { audience: 'bulle', scopes: 'bulle.read bulle.write' };
const bulle = new Client({
  url: process.env.BULLE_URL!,
  token: (userId) => tokens.token(userId, target),
  forget: (userId) => tokens.forget(userId, target),
});

const { text } = await bulle.complete(userId, { prompt: 'Summarise this thread.', input: thread, spaceId });
const list = await bulle.ideas(userId, 'glouton', spaceId);
```

- `complete` posts to `/api/ai/complete`; with `schema` the answer comes back as `json`.
  `spaceId` is sent only when set. Pass a longer `timeoutMs` (the third argument) than the 20 s
  default for long completions.
- `decideAI` posts to `/api/ai/decide` with a service key as token and the person's email in
  `X-Bulle-Acting-For`. `decide` answers a run's pending approval.
- `call(user, { method, segments, query, body })` reaches any other route. Segments are escaped
  one by one, so an id holding `/` or `?` stays one segment; `.`, `..` and empty ones throw
  `BadSegmentError` before any call.
- A 402 throws `PlanRequired` (`message`, `upgradeUrl`, `key`), another 4xx `StatusError`
  (`status`, `code`, `message`), and a 5xx, timeout, network error or redirect
  `UnreachableError`. A token source failure is thrown as it is.

## Development

```sh
bun install
bun run typecheck
bun test                 # set TEST_DATABASE_URL to run the Postgres store test
filet check .
sh scripts/sync-vectors.sh v0.22.2   # refresh testdata/vectors from a Go tronc tag
```

## License

MIT, see [LICENSE](LICENSE).
