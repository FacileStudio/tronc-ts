import { afterAll, describe, expect, test } from 'bun:test';
import { newIssuer } from '../mcptest';
import { mount, newTool, registreVerifier, type Router } from '.';

const issuer = await newIssuer();
const resource = 'http://127.0.0.1:1/mcp';
const verifier = await registreVerifier({ issuer: issuer.url, resource, scopePrefix: 'probe' });
afterAll(() => issuer.close());

const reader = newTool({
  name: 'probe_read', title: 'Read', description: 'Reads.', inputSchema: { type: 'object' },
  annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
}, async () => ({ ok: true }));

describe('Server', () => {
  const routes = new Map<string, (c: { req: { raw: Request } }) => Promise<Response>>();
  const router: Router = { all: (path, handler) => routes.set(path, handler) };
  const server = mount(router, {
    name: 'probe', title: 'Probe', version: '1', resource, issuer: issuer.url, verifier,
    scopes: { read: 'probe.read' }, rateLimit: { rate: 0.001, burst: 1 }, tools: [reader],
  });

  test('mounts the endpoint, its metadata and the bare well-known path', () => {
    expect([...routes.keys()]).toEqual(['/mcp', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']);
    expect(server.metadata().scopes_supported).toEqual(['probe.read']);
  });

  test('answers 429 with the suite envelope and Retry-After past the burst', async () => {
    const token = await issuer.token(resource, 'person', 'probe.read');
    const call = () => server.fetch(new Request(resource, {
      method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    }));
    expect((await call()).status).toBe(200);
    const refused = await call();
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).not.toBeNull();
    expect(await refused.json()).toEqual({ error: { code: 'rate_limited', message: 'too many requests' } });
  });

  test('answers 404 with the envelope off its paths', async () => {
    const response = await server.fetch(new Request('http://127.0.0.1:1/other'));
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('not_found');
  });

  test('refuses a writing tool on a read-only server at boot', () => {
    const writer = newTool({ ...reader.spec, name: 'probe_write', annotations: { ...reader.spec.annotations, readOnly: false } }, async () => ({}));
    expect(() => mount(router, { name: 'probe', title: 'P', version: '1', resource, issuer: issuer.url, verifier, scopes: { read: 'probe.read' }, tools: [writer] }))
      .toThrow('write scope');
  });
});
