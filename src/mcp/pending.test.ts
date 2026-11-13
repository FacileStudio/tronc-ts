import { describe, expect, test } from 'bun:test';
import { OPEN_LIMIT, OUTCOME_DONE, PENDING_SCHEMA, SqlPending, TroncError, type Action } from '.';

const url = process.env.TEST_DATABASE_URL;

/** A fresh action for userId. */
function action(id: string, userId = 'u1'): Action {
  const now = new Date();
  return {
    id, userId, kind: 'delete', target: 't', digest: 'd', summary: 's', clientId: 'c',
    createdAt: now, expiresAt: new Date(now.getTime() + 60_000),
  };
}

describe.skipIf(!url)('SqlPending on Postgres', () => {
  test('claims an open action exactly once, and only for its owner', async () => {
    const db = new Bun.SQL(url!);
    await db.unsafe('DROP TABLE IF EXISTS mcp_actions');
    await db.unsafe(PENDING_SCHEMA);
    const store = new SqlPending((sql, params) => db.unsafe(sql, params as never[]));
    await store.create(action('a1'));
    await store.create(action('a2'));
    expect((await store.open('u1')).map((a) => a.id).sort()).toEqual(['a1', 'a2']);
    await expect(store.claim('u2', 'a1')).rejects.toBeInstanceOf(TroncError);
    const claims = await Promise.allSettled([store.claim('u1', 'a1'), store.claim('u1', 'a1')]);
    expect(claims.filter((c) => c.status === 'fulfilled')).toHaveLength(1);
    await store.finish('a1', OUTCOME_DONE);
    await store.resolve('u1', 'a2', 'dismissed');
    await expect(store.resolve('u1', 'a2', 'dismissed')).rejects.toBeInstanceOf(TroncError);
    expect(await store.open('u1')).toEqual([]);
    await store.create(action('a3'));
    await store.create(action('b1', 'u2'));
    await store.erase('u1');
    expect(await store.open('u1')).toEqual([]);
    expect((await store.open('u2')).map((a) => a.id)).toEqual(['b1']);
    await db.unsafe('DROP TABLE mcp_actions');
    await db.close();
  });

  test('reads at most OPEN_LIMIT + 1 open actions, and prunes only what closed or expired long ago', async () => {
    const db = new Bun.SQL(url!);
    await db.unsafe('DROP TABLE IF EXISTS mcp_actions');
    await db.unsafe(PENDING_SCHEMA);
    const store = new SqlPending((sql, params) => db.unsafe(sql, params as never[]));
    for (let i = 0; i < OPEN_LIMIT + 5; i++) await store.create(action(`o${i}`, 'u3'));
    expect(await store.open('u3')).toHaveLength(OPEN_LIMIT + 1);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await store.create({ ...action('stale'), createdAt: old, expiresAt: old });
    await store.create(action('closed-old'));
    await store.create(action('closed-new'));
    await store.resolve('u1', 'closed-new', 'dismissed');
    await db.unsafe("UPDATE mcp_actions SET resolved_at = $1, outcome = 'done' WHERE id = 'closed-old'", [old]);
    expect(await store.prune(30 * 24 * 60 * 60 * 1000)).toBe(2);
    const left = await db.unsafe("SELECT id FROM mcp_actions WHERE user_id = 'u1' ORDER BY id");
    expect(left.map((r: { id: string }) => r.id)).toEqual(['closed-new']);
    await db.unsafe('DROP TABLE mcp_actions');
    await db.close();
  });
});
