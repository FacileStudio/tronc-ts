# Changelog

All notable changes to `tronc-ts` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow semver. While on
`v0`, a breaking change bumps the minor.

## [Unreleased]

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
