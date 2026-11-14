# Changelog

All notable changes to `tronc-ts` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow semver. While on
`v0`, a breaking change bumps the minor.

## [0.3.1] - 2026-11-14

Ports Go tronc v0.23.1 and runs its conformance vectors.

### Security

- **Pending-action dedupe matches the OAuth client.** `Confirmations.request` reuses an open
  action only when the user, kind, target, digest and the requesting client id all match.
  Before, a second client of the same person reused the first client's action, so consent given
  to client B could let client A collect the result. Each client now opens its own action.

### Added

- **`StatusError.retryAfterMs`**: the wait, in milliseconds, that Bulle's `Retry-After` header
  names on a 429 or a 503, read from delay seconds or an IMF-fixdate, capped at a day, 0 when
  absent, unreadable or past. A 503 with a `Retry-After` now throws a `StatusError` that is still
  `instanceof UnreachableError`, like Go's `StatusError` that wraps `ErrUnreachable`; a 503
  without one is unchanged. `retryAfterMs(value, now?)` is exported.
- Vectors synced from Go tronc v0.23.1; the `bulle_errors` runner sends `retry_after` and checks
  the optional `retry_after_seconds`.

## [0.3.0] - 2026-11-14

Ports Go tronc/bulle and the MCP changes of Go tronc v0.23.0, and runs every v0.23.0
conformance vector that applies to TypeScript.

### Added

- **`@facile/tronc/bulle`**, the Bulle client: `call`/`send` with Go's segment and query escaping,
  `ideas`, `generate`, `run`, `runStatus`, `decide` (a run's approval), `dismiss`, a typed
  `complete` on `/api/ai/complete` (with `spaceId`) and `decideAI` on `/api/ai/decide`. A 402 is
  `PlanRequired` (with `limit`) with an unsafe upgrade page dropped, another 4xx `StatusError`,
  and a 5xx, timeout, network error or redirect `UnreachableError`. A 401 retries once after
  `forget`. Redirects are never followed. `decideAI` trims `actingFor` and throws
  `NoActingForError` before any call when it is blank. A caller's header never joins or replaces
  `Authorization`. Error bodies are read with Go's case-insensitive keys. The call type is
  `BulleRequest`, so it does not shadow the global `Request`.
- **`safeUpgradeUrl`**, Go's `errors.SafeUpgradeURL`, now on a port of Go `url.Parse` (bad `%`
  escapes, host bytes, ports), and `troncErrorOf`, which finds a `TroncError` along an error's
  cause chain like Go's `errors.As`. A run output's link is written back as Go's `URL.String`.
- **`stateKey(app, secret)`**, Go `mcp.StateKey`: SHA-256 over `<app>-mcp-state:<secret>`.
- **Bounded pending actions**, as Go v0.23.0. `Confirmations.request` reuses the person's open
  action of the same kind, target and digest. `SqlPending.open` reads at most `OPEN_LIMIT` + 1
  rows, and `Confirmations.list` keeps `OPEN_LIMIT` (100) and reports `truncated`.
  `SqlPending.prune`, `prunePending(query, olderThanMs)` and `keepPruned(store, opts)` delete the
  actions resolved or expired more than 30 days ago, hourly.
- **Confirmation text.** `Outcome.message` carries Go's waiting text on a link and
  `MESSAGE_DECLINED` on a decline; `Confirmations.waiting()` names the pending lifetime.
- **Offset pager** `page(items, cursor, size)`, `offsetOf(cursor)` and `cursorAt(offset, total)`,
  Go's `Page`, `Offset` and `Cursor`.
- **`PlanLimit`**: `failure` maps any error with `planLimit()` along the cause chain to "The plan
  limit for <feature> is reached. Upgrade at <url>", as Go.
- **Go conformance vectors** from tronc v0.23.0 in `testdata/vectors`, synced by
  `scripts/sync-vectors.sh <tag>` and checked in CI against the recorded tag. `errors`,
  `mcp_http`, `mcp_rate_limit`, `mcp_digest`, `mcp_state_key`, `mcp_failure`, `bulle_errors`
  and `bulle_paths` run. `mcp_http` compares only the status and the challenge's scope and
  `resource_metadata` of a 401 or 403, whose body comes from the official SDK's RFC 6750 gate;
  every other answer is byte for byte. Go's HTTP chassis subjects are listed as Go-only.

### Changed

- **Breaking:** the MCP rate limit defaults to 120 calls a minute with a burst of 120, as Go
  `NewApp`. A token without a person gets a bucket of its own instead of a shared `anonymous` one.
- **Breaking:** a 429 is plain text `rate limit exceeded` and a foreign `Origin` a plain-text
  403 `Forbidden: origin not allowed`, as Go answers both.
- `failure` keeps an `unavailable` error's message, re-checks a `payment_required` upgrade page
  and capitalises the first character, not the first UTF-16 unit.
- GET and DELETE on the MCP endpoint answer a plain-text 405, the 429 drops
  `X-Content-Type-Options`, and the RFC 9728 document is written as Go's encoder writes it, with
  `Content-Type: application/json`.
- A non-tronc error's envelope message is `internal server error`, and envelope bodies are byte
  for byte Go's `httpjson.WriteError`. A `TroncError` drops an upgrade page that is not a
  same-origin path or an https URL, and `failure` and `envelope` read a wrapped `TroncError`.

## [0.2.0] - 2026-11-11

Ports `Digest` and `Pending.Erase` from Go tronc/mcp v0.22.0. Its chi confirm-page routes (`PendingPage`), `NewApp` and `TargetIDs` stay Go-only.

### Added

- **`digest(...fields)`**, the fingerprint for `Kind.fingerprint`: hex of the first 16 bytes of
  SHA-256 over the fields joined by NUL, byte for byte Go's `mcp.Digest`.
- **Erasing pending actions.** `Pending.erase(...userIds)`, implemented by `SqlPending` and
  `MemoryPending`, and `erasePending(query, ...userIds)` to run the same delete inside an account
  erasure's own transaction.

### Changed

- **Breaking for custom stores:** `Pending` gains `erase`.

## [0.1.0] - 2026-11-11

### Added

- **`@facile/tronc/mcp`**, a remote MCP server kit on `@modelcontextprotocol/server` 2.4
  (`createMcpHandler`), with the conventions of Go `tronc/mcp`: stateless on spec 2026-07-28
  with the 2025 stateless fallback, 405 on GET, an exact Origin check, tools sorted by name and
  cached privately, RFC 9728 metadata at the resource's well-known path and the bare one, a
  bearer gate, a 403 `insufficient_scope` challenge on write tools for read-only tokens,
  read-only servers, and a per-person token bucket answering 429 with the suite envelope.
- **`registreVerifier`**, the counterpart of `porte/mcpauth.Verifier`: RS256 against Registre's
  JWKS through `jose`, exact `iss`, required `exp` and `sub`, a resource-bound audience, the
  app's client id on delegated tokens only, write implying read, and a `resolveUser` hook.
- **`newTool`** with required app-prefixed names, titles, descriptions and all four annotations;
  JSON Schema or Standard Schema arguments; errors mapped through `failure` so internal detail
  never reaches a model.
- **`Confirmations`**: MRTR `input_required` questions signed with HMAC-SHA256 in Go's state
  format, a pending action plus confirm link for clients that cannot elicit, single-use claims, a
  changed-target guard, and `SqlPending` on Go's `mcp_actions` table over any Postgres client.
- The paging helpers (`detailed`, `encodeCursor`, `decodeCursor`, `fitCount`, `encodedSize`,
  `clip`), the suite error envelope (`TroncError`, `envelope`, `errorResponse`) and `audit`.
- **`@facile/tronc/mcp/mcptest`**, the conformance kit: a fake issuer, `MemoryPending`, client
  helpers, and `run`, which registers bun tests for the transport, the tools, the write scope and
  every sensitive tool's confirmation path.
