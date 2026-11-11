import { afterAll, describe, expect, test } from 'bun:test';
import { OAuthError } from '@modelcontextprotocol/server';
import { newIssuer } from '../mcptest';
import { EXTRA_ACTOR, EXTRA_USER_ID, registreVerifier } from '.';

const issuer = await newIssuer();
const resource = 'https://glouton.example/mcp';
afterAll(() => issuer.close());

const verifier = await registreVerifier({
  issuer: issuer.url, resource, scopePrefix: 'glouton', audience: 'glouton-client',
  resolveUser: async (claims) => (claims.subject === 'known' ? 'user-1' : undefined),
});

/** The OAuth error code a verification failed with. */
async function refusal(token: string): Promise<string> {
  try {
    await verifier.verifyAccessToken(token);
    return 'accepted';
  } catch (err) {
    return err instanceof OAuthError ? err.code : String(err);
  }
}

describe('registreVerifier', () => {
  test('accepts a resource-bound token and resolves the person', async () => {
    const info = await verifier.verifyAccessToken(await issuer.token(resource, 'known', 'glouton.write'));
    expect(info.extra?.[EXTRA_USER_ID]).toBe('user-1');
    expect(info.scopes).toEqual(['glouton.write', 'glouton.read']);
    expect(info.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  test('accepts the app audience only on a delegated token', async () => {
    const delegated = await issuer.mint({ aud: 'glouton-client', sub: 'known', client_id: 'bulle', act: { sub: 'bulle' } });
    expect((await verifier.verifyAccessToken(delegated)).extra?.[EXTRA_ACTOR]).toBe('bulle');
    expect(await refusal(await issuer.mint({ aud: 'glouton-client', sub: 'known' }))).toBe('invalid_token');
  });

  test('refuses another audience, an expired token, another issuer and an unknown person', async () => {
    expect(await refusal(await issuer.token('https://other.example/mcp', 'known'))).toBe('invalid_token');
    expect(await refusal(await issuer.mint({ aud: resource, sub: 'known', exp: Math.floor(Date.now() / 1000) - 120 }))).toBe('invalid_token');
    expect(await refusal(await issuer.mint({ aud: resource, sub: 'known', iss: 'https://evil.example' }))).toBe('invalid_token');
    expect(await refusal(await issuer.mint({ aud: resource, sub: 'known', exp: undefined }))).toBe('invalid_token');
    expect(await refusal(await issuer.token(resource, 'stranger'))).toBe('invalid_token');
    expect(await refusal('not-a-jwt')).toBe('invalid_token');
  });

  test('answers server_error when the account store fails', async () => {
    const broken = await registreVerifier({
      issuer: issuer.url, resource, scopePrefix: 'glouton', resolveUser: async () => { throw new Error('db down'); },
    });
    await expect(broken.verifyAccessToken(await issuer.token(resource, 'known'))).rejects.toMatchObject({ code: 'server_error' });
  });
});
