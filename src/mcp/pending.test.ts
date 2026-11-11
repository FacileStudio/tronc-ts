import { describe, expect, test } from 'bun:test';
import { OUTCOME_DONE, PENDING_SCHEMA, SqlPending, TroncError, type Action } from '.';

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
    await db.unsafe('DROP TABLE mcp_actions');
    await db.close();
  });
});
