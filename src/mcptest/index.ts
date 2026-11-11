/**
 * The conformance kit for servers built on @facile/tronc/mcp, the TypeScript
 * counterpart of Go tronc/mcp/mcptest. run registers bun tests that check a
 * live endpoint the way MCP clients and the suite expect it: the 401
 * challenge naming the RFC 9728 metadata, the metadata itself, 405 on GET,
 * the Origin check, explicit annotations, valid schemas, a stable sorted tool
 * list cached privately, the 403 write-scope challenge, and for each
 * sensitive tool the whole confirmation path.
 */
import { describe, test } from 'bun:test';
import { answering } from './client';
import { checkChallenge, checkTools, checkTransport, checkWriteScope, listed } from './checks';
import { checkAccept, checkDecline, checkForgery, checkLink } from './confirm';

export * from './client';
export * from './issuer';
export * from './pending';
export { assert, metadataUrlOf } from './checks';

/** Points run at a running endpoint. Fields are read when the tests run, so beforeAll may fill them. */
export interface Config {
  /** The resource URI the endpoint serves. */
  url: string;
  /** Mints a valid access token for url with scopes, or with every scope the metadata lists when none is given. */
  token: (...scopes: string[]) => Promise<string>;
  /** The sensitive tools and how to set up a fresh target for each run. */
  confirm?: ConfirmCase[];
}

/** One sensitive tool under test. */
export interface ConfirmCase {
  tool: string;
  /** Creates a fresh target and returns the tool arguments for it, plus a count of how many times the action ran. */
  setup: () => Promise<{ args: Record<string, unknown>; runs: () => number }>;
}

/** Registers the conformance tests for cfg. confirm cases are read at registration time. */
export function run(cfg: Config): void {
  describe('mcp conformance', () => {
    test('challenge and metadata', () => checkChallenge(cfg).then(() => undefined));
    test('get is not allowed and a foreign origin is refused', () => checkTransport(cfg));
    test('tools', async () => {
      const meta = await checkChallenge(cfg);
      checkTools(await listed(cfg), `${meta.scopes_supported[0]!.split('.')[0]}_`);
    });
    test('write scope', async () => checkWriteScope(cfg, await listed(cfg), await checkChallenge(cfg)));
    for (const c of cfg.confirm ?? []) describe(`confirm ${c.tool}`, () => confirmTests(cfg, c));
  });
}

/** Registers the confirmation path of one sensitive tool. */
function confirmTests(cfg: Config, c: ConfirmCase): void {
  test('no elicitation gets a link', () => checkLink(cfg, c, {}));
  test('pre-mrtr client gets a link', async () => {
    const asked = { count: 0 };
    await checkLink(cfg, c, { elicit: answering('accept', asked), version: 'legacy' });
    if (asked.count !== 0) throw new Error(`a stateless server cannot ask a pre-MRTR client, yet it asked ${asked.count} times`);
  });
  test('decline runs nothing', () => checkDecline(cfg, c));
  test('accept runs once', () => checkAccept(cfg, c));
  test('link id is not a state', () => checkForgery(cfg, c));
}
