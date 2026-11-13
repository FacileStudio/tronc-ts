import { afterAll, describe, expect, test } from 'bun:test';
import { BadSegmentError, Client, encodeQuery, pathEscape, PlanRequired, StatusError, UnreachableError } from '.';

interface Seen {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
}

function fake(answer: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { method: init?.method ?? 'GET', url: String(input), headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    seen.push(call);
    return answer(call);
  }) as typeof fetch;
  return { seen, fetcher };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const client = (fetcher: typeof fetch, extra: Partial<ConstructorParameters<typeof Client>[0]> = {}) =>
  new Client({ url: 'https://bulle.test/', token: async (user) => `tok-${user}`, fetch: fetcher, ...extra });

describe('escaping', () => {
  test('matches Go url.PathEscape and url.Values.Encode byte for byte', () => {
    expect(pathEscape('a b/c?d;e,f')).toBe('a%20b%2Fc%3Fd%3Be%2Cf');
    expect(pathEscape("$&+:=@!*'()~é")).toBe('$&+:=@%21%2A%27%28%29~%C3%A9');
    expect(encodeQuery({ z: 'a b*~!', app: 'glouton&x=é' })).toBe('app=glouton%26x%3D%C3%A9&z=a+b%2A~%21');
  });

  test('keeps a hostile id in one segment and refuses dot and empty segments before any call', async () => {
    const { seen, fetcher } = fake(() => json(200, {}));
    await client(fetcher).dismiss('u1', '../runs/x');
    expect(seen[0]).toMatchObject({ method: 'PATCH', url: 'https://bulle.test/api/ideas/..%2Fruns%2Fx', body: { status: 'dismissed' } });
    expect(seen[0]!.headers.get('Authorization')).toBe('Bearer tok-u1');
    for (const id of ['', '.', '..', 'x'.repeat(201)]) {
      await expect(client(fetcher).dismiss('u1', id)).rejects.toBeInstanceOf(BadSegmentError);
    }
    expect(seen).toHaveLength(1);
  });

  test('refuses a base url that is not an http or https origin', () => {
    for (const url of ['ftp://bulle.test', 'bulle.test', 'https://u:p@bulle.test']) {
      expect(() => new Client({ url, token: async () => 't' })).toThrow('bulle: url');
    }
  });
});

describe('answers', () => {
  test('reads a 402 bare or in the envelope and drops an unsafe upgrade page', async () => {
    const bodies = [
      { error: { code: 'payment_required', message: 'AI needs a plan', upgrade_url: 'https://sso.test/up', key: 'ai.access' } },
      { message: 'AI needs a plan', upgrade_url: 'javascript:alert(1)', key: 'ai.access' },
      { message: 'AI needs a plan', upgrade_url: 'http://sso.test/up' },
    ];
    const wants = ['https://sso.test/up', '', ''];
    for (const [i, body] of bodies.entries()) {
      const err = await client(fake(() => json(402, body)).fetcher).call('u1', { method: 'GET', segments: ['ideas'] }).catch((e) => e);
      expect(err).toBeInstanceOf(PlanRequired);
      expect(err).toMatchObject({ message: 'AI needs a plan', upgradeUrl: wants[i] });
    }
  });

  test('maps a 4xx to StatusError, a 5xx and an unreadable body to UnreachableError', async () => {
    const run = (response: () => Response) => client(fake(response).fetcher).call('u1', { method: 'GET', segments: ['x'] }).catch((e) => e);
    expect(await run(() => json(404, { error: { code: 'not_found', message: 'no such idea' } }))).toMatchObject({ status: 404, code: 'not_found', message: 'no such idea' });
    expect(await run(() => json(429, { error: 'three a day' }))).toMatchObject({ status: 429, message: 'three a day' });
    expect(await run(() => json(409, [1]))).toBeInstanceOf(StatusError);
    expect(await run(() => json(503, {}))).toBeInstanceOf(UnreachableError);
    expect(await run(() => new Response('{', { status: 200 }))).toBeInstanceOf(UnreachableError);
    expect(await client(fake(() => new Response('', { status: 200 })).fetcher).call('u1', { method: 'GET', segments: ['x'] })).toBeUndefined();
  });

  test('throws a network failure as UnreachableError and a token source failure as it is', async () => {
    const down = client((async () => { throw new TypeError('connection refused'); }) as unknown as typeof fetch);
    await expect(down.call('u1', { method: 'GET', segments: ['x'] })).rejects.toBeInstanceOf(UnreachableError);
    const unlinked = new Client({ url: 'https://bulle.test', token: async () => { throw new RangeError('reconnect'); }, fetch: fake(() => json(200, {})).fetcher });
    await expect(unlinked.call('u1', { method: 'GET', segments: ['x'] })).rejects.toBeInstanceOf(RangeError);
  });

  test('retries a 401 once after forget', async () => {
    let forgotten = 0;
    const { seen, fetcher } = fake(() => json(401, { error: { code: 'unauthenticated', message: 'expired' } }));
    const err = await client(fetcher, { forget: () => { forgotten++; } }).call('u1', { method: 'GET', segments: ['x'] }).catch((e) => e);
    expect(err).toMatchObject({ status: 401 });
    expect([seen.length, forgotten]).toEqual([2, 1]);
  });
});

describe('redirects', () => {
  const elsewhere = Bun.serve({ port: 0, fetch: () => Response.json({ leaked: true }) });
  const bulle = Bun.serve({ port: 0, fetch: () => Response.redirect(`http://127.0.0.1:${elsewhere.port}/api/x`, 302) });
  afterAll(() => {
    bulle.stop(true);
    elsewhere.stop(true);
  });

  test('refuses to follow a redirect, so the token never reaches another host', async () => {
    const real = new Client({ url: `http://127.0.0.1:${bulle.port}`, token: async () => 't' });
    await expect(real.call('u1', { method: 'GET', segments: ['x'] })).rejects.toBeInstanceOf(UnreachableError);
  });
});

describe('typed calls', () => {
  test('complete sends snake_case and space_id only when set', async () => {
    const { seen, fetcher } = fake(() => json(200, { json: { tone: 'warm' }, model: 'm1' }));
    const bulle = client(fetcher);
    const schema = { type: 'object' };
    expect(await bulle.complete('u1', { prompt: 'p', input: 'mail', schema, maxTokens: 200, spaceId: 'sp1' })).toEqual({ json: { tone: 'warm' }, model: 'm1' });
    await bulle.complete('u1', { prompt: 'p' });
    expect(seen.map((s) => [s.url, s.body])).toEqual([
      ['https://bulle.test/api/ai/complete', { prompt: 'p', input: 'mail', schema, max_tokens: 200, space_id: 'sp1' }],
      ['https://bulle.test/api/ai/complete', { prompt: 'p' }],
    ]);
  });

  test('decideAI names the person in X-Bulle-Acting-For', async () => {
    const { seen, fetcher } = fake(() => json(200, { answers: { project: { choice: 'a', confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } } }, model: 'j', usage: {} }));
    const questions = { project: { type: 'choice' as const, instructions: 'which project', options: ['a', 'b'] } };
    const answer = await client(fetcher).decideAI('sablier', { actingFor: 'ada@x.test', state: { title: 't' }, questions });
    expect(answer.answers.project?.choice).toBe('a');
    expect(seen[0]!.headers.get('X-Bulle-Acting-For')).toBe('ada@x.test');
    expect(seen[0]!.body).toEqual({ state: { title: 't' }, questions });
  });

  test('ideas scope app and space, and runStatus derives the state and keeps only web links', async () => {
    const { seen, fetcher } = fake(({ url }) => url.includes('/runs/')
      ? json(200, { id: 'r1', session_id: 's 1', status: 'running', pending_approvals: [{ call_id: 'c1' }], outputs: [{ url: 'javascript:alert(1)' }, { url: 'https://docs.test/d/1' }] })
      : json(200, { ideas: null, generating: true }));
    const bulle = client(fetcher);
    expect((await bulle.ideas('u1', 'glouton', 'sp 1')).ideas).toEqual([]);
    const run = await bulle.runStatus('u1', 'r1');
    expect(seen[0]!.url).toBe('https://bulle.test/api/ideas?app=glouton&space_id=sp+1');
    expect([run.state, run.continue_url, run.outputs.map((o) => o.url)]).toEqual(['needs_approval', 'https://bulle.test/s/s%201', ['', 'https://docs.test/d/1']]);
  });
});
