import { describe, expect, test } from 'bun:test';
import {
  checkTools, clip, rateKey, digest, decodeCursor, detailed, encodeCursor, ERR_UNAVAILABLE, failure, fitCount, invalid, Limiter,
  newTool, notFound, Signer, TroncError, envelope,
} from '.';

describe('Signer', () => {
  const signer = new Signer(new TextEncoder().encode('k'.repeat(32)), 60_000);
  const later = new Date(Date.now() + 60_000);

  test('verifies its own state for the same person only', () => {
    const state = signer.sign('u1', 'a1', later);
    expect(signer.verify(state, 'u1', new Date())).toBe('a1');
    expect(() => signer.verify(state, 'u2', new Date())).toThrow(TroncError);
  });

  test('refuses a tampered mac, a tampered id and an expired state', () => {
    const [user, id, exp, mac] = signer.sign('u1', 'a1', later).split('.');
    const flipped = mac!.slice(0, -1) + (mac!.endsWith('0') ? '1' : '0');
    expect(() => signer.verify([user, id, exp, flipped].join('.'), 'u1', new Date())).toThrow(TroncError);
    expect(() => signer.verify([user, 'a2', exp, mac].join('.'), 'u1', new Date())).toThrow(TroncError);
    expect(() => signer.verify(signer.sign('u1', 'a1', new Date(Date.now() - 1000)), 'u1', new Date())).toThrow(TroncError);
  });
});

describe('failure and envelope', () => {
  test('keeps actionable messages and hides the rest', () => {
    expect(failure(invalid('pass an id')).message).toBe('Pass an id');
    expect(failure(notFound('no such lead'), 'List them with glouton_leads_search.').message)
      .toBe('No such lead. List them with glouton_leads_search.');
    expect(failure(new Error('pq: connection refused')).message).toBe(ERR_UNAVAILABLE);
    const plan = new TroncError('payment_required', 'this needs a paid plan.', { upgradeUrl: 'https://x.example/up' });
    expect(failure(plan).message).toBe('This needs a paid plan. Upgrade at https://x.example/up');
  });

  test('writes the suite envelope and never leaks a foreign error', () => {
    expect(envelope(notFound('gone'))).toEqual({ error: { code: 'not_found', message: 'gone' } });
    expect(envelope(new Error('secret detail'))).toEqual({ error: { code: 'internal', message: 'internal server error' } });
  });

  test('drops an upgrade page a client could not render safely, like Go SafeUpgradeURL', () => {
    const page = (url: string) => new TroncError('payment_required', 'plan required', { upgradeUrl: url }).upgradeUrl;
    for (const url of ['https://x.example/up', '/billing?plan=pro', 'HTTPS://x.example']) expect(page(url)).toBe(url);
    for (const url of ['javascript:alert(1)', '//evil.example', 'http://x.example', 'https://u:p@x.example', '/\\evil', 'https:evil.example', '/a b', 'https://']) {
      expect(page(url)).toBeUndefined();
    }
    expect(failure(new TroncError('payment_required', 'plan required', { upgradeUrl: 'javascript:alert(1)' })).message).toBe('Plan required.');
  });
});

describe('page helpers', () => {
  test('round-trip cursors and refuse a foreign one', () => {
    expect(decodeCursor<{ after: number }>(encodeCursor({ after: 3 }))).toEqual({ after: 3 });
    expect(() => decodeCursor('%%%')).toThrow();
    expect(() => detailed('verbose')).toThrow();
    expect(detailed('detailed')).toBe(true);
  });

  test('fit the budget and clip on a character boundary', () => {
    expect(fitCount(100, (n) => n * 1000)).toBe(75);
    expect(fitCount(10, () => 1)).toBe(10);
    expect(clip('héllo', 2)).toEqual({ text: 'h', clipped: true });
    expect(clip('abc', 5)).toEqual({ text: 'abc', clipped: false });
  });
});

describe('Limiter', () => {
  test('refuses past the burst, isolates keys and refills', () => {
    const limiter = new Limiter({ rate: 1, burst: 2 });
    expect(limiter.allow('a', 0).ok).toBe(true);
    expect(limiter.allow('a', 0).ok).toBe(true);
    expect(limiter.allow('a', 0)).toEqual({ ok: false, retryAfter: 1 });
    expect(limiter.allow('b', 0).ok).toBe(true);
    expect(limiter.allow('a', 1000).ok).toBe(true);
  });
});

describe('checkTools', () => {
  const tool = (name: string, readOnly = true, destructive = false) => newTool({
    name, title: 't', description: 'd', inputSchema: { type: 'object' },
    annotations: { readOnly, destructive, idempotent: true, openWorld: false },
  }, async () => ({}));

  test('refuses a bad prefix, a duplicate, a read-only destructive tool and a write without scope', () => {
    expect(() => checkTools([tool('other_x')], 'notes_', 'notes.write')).toThrow('must be named');
    expect(() => checkTools([tool('notes_x'), tool('notes_x')], 'notes_', 'notes.write')).toThrow('twice');
    expect(() => checkTools([tool('notes_x', true, true)], 'notes_', 'notes.write')).toThrow('read-only and destructive');
    expect(() => checkTools([tool('notes_x', false)], 'notes_', undefined)).toThrow('write scope');
    expect(() => checkTools([tool('notes_Bad')], 'notes_', 'notes.write')).toThrow('must be named');
  });
});

describe('digest', () => {
  test('matches Go tronc/mcp Digest byte for byte', () => {
    expect(digest('42', 'Lunch', '2026-11-11')).toBe('5e9be4c7b3d9dfa4dcb9eba0b0b772b4');
  });
});

describe('rateKey', () => {
  test('keys a person by user id and a token without a person by its own hash', () => {
    const info = (token: string, extra?: Record<string, unknown>) => ({ token, clientId: 'c', scopes: [], extra });
    expect(rateKey(info('t1', { user_id: '7' }))).toBe('user:7');
    expect(rateKey(info('t1'))).not.toBe(rateKey(info('t2')));
    expect(rateKey(info('t1'))).not.toContain('t1');
  });
});
