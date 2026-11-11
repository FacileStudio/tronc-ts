import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';

/** The client_id Claude Code registers with through CIMD, the default client of a minted token. */
export const CLAUDE_CODE_CLIENT = 'https://claude.ai/oauth/claude-code-client-metadata';

/** A fake authorization server for tests: OpenID discovery, one RSA key in its JWKS, and an RS256 minter. */
export interface Issuer {
  url: string;
  /** Mints an access token for subject on resource with scopes, issued to Claude Code, valid ten minutes. */
  token(resource: string, subject: string, ...scopes: string[]): Promise<string>;
  /** Signs a token. claims override the defaults (iss, sub, aud, client_id, exp, iat, jti); undefined removes one. */
  mint(claims: Record<string, unknown>): Promise<string>;
  /** Stops the server. */
  close(): void;
}

/** Starts an Issuer on a free local port. */
export async function newIssuer(): Promise<Issuer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  let url = '';
  const server = Bun.serve({
    port: 0,
    fetch(request: Request): Response {
      const path = new URL(request.url).pathname;
      if (path === '/.well-known/openid-configuration') return Response.json({ issuer: url, jwks_uri: `${url}/jwks` });
      if (path === '/jwks') return Response.json({ keys: [jwk] });
      return new Response('not found', { status: 404 });
    },
  });
  url = `http://127.0.0.1:${server.port}`;
  const mint = (claims: Record<string, unknown>) => sign(privateKey, url, claims);
  return {
    url,
    mint,
    token: (resource, subject, ...scopes) => mint({ aud: [resource], sub: subject, scope: scopes.join(' ') }),
    close: () => void server.stop(true),
  };
}

/** Signs claims over the defaults with key. */
async function sign(key: CryptoKey, issuer: string, claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const body: Record<string, unknown> = {
    iss: issuer, sub: 'subject', client_id: CLAUDE_CODE_CLIENT, exp: now + 600, iat: now, jti: crypto.randomUUID(),
  };
  for (const [name, value] of Object.entries(claims)) {
    if (value === undefined) delete body[name];
    else body[name] = value;
  }
  return new SignJWT(body).setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'k1' }).sign(key);
}
