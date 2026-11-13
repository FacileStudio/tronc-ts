# Changelog

All notable changes to `tronc-ts` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow semver. While on
`v0`, a breaking change bumps the minor.

## [Unreleased]

Ports Go tronc/bulle (unchanged since v0.18.0) and aligns the MCP kit's refusals with Go tronc
v0.22.2. Go: tronc v0.23.0 adds the typed `Complete` with `SpaceID`, the decision call, refused
redirects and the vectors this package will consume.

### Added

- **`@facile/tronc/bulle`**, the Bulle client: `call`/`send` with Go's segment and query escaping,
  `ideas`, `generate`, `run`, `runStatus`, `decide` (a run's approval), `dismiss`, a typed
  `complete` on `/api/ai/complete` (with `spaceId`) and `decideAI` on `/api/ai/decide`. A 402 is
  `PlanRequired` with an unsafe upgrade page dropped, another 4xx `StatusError`, and a 5xx,
  timeout, network error or redirect `UnreachableError`. A 401 retries once after `forget`.
  Redirects are never followed.
- **`safeUpgradeUrl`**, Go's `errors.SafeUpgradeURL`, and `troncErrorOf`, which finds a
  `TroncError` along an error's cause chain like Go's `errors.As`.
- **Go conformance vectors** in `testdata/vectors`, synced by `scripts/sync-vectors.sh <tag>`
  and checked in CI against the recorded tag. `errors.json` runs; each other subject is listed
  as Go-only, and a new vector file fails the test until it gets a runner or that listing.

### Changed

- **Breaking:** the MCP rate limit defaults to 120 calls a minute with a burst of 120, as Go
  `NewApp`. A token without a person gets a bucket of its own instead of a shared `anonymous` one.
- **Breaking:** a 429 is plain text `rate limit exceeded` and a foreign `Origin` a plain-text
  403 `Forbidden: origin not allowed`, as Go answers both.
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
