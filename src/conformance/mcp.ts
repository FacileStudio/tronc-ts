import { OAuthError, OAuthErrorCode, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { newServer, newTool, type Server } from '../mcp';

/** The string at key of input, or undefined. */
export const str = (input: Record<string, unknown>, key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined);

/** value without the empty strings and zeros Go's omitempty leaves out. */
export function omitEmpty(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== '' && v !== 0 && v !== undefined));
}

/** What an mcp_rate_limit case wants: the calls each user got through and what the refusal looked like. */
export interface RateWant {
  allowed: Record<string, number>;
  refused_status: number;
  refused_content_type: string;
  refused_body: string;
  retry_after: boolean;
}

/** Accepts "user|scope,scope" tokens, like the Go vectors' verifier; anything else is invalid. */
const vectorVerifier: OAuthTokenVerifier = {
  async verifyAccessToken(token: string) {
    const [user, scopes] = token.split('|');
    if (!user || scopes === undefined) throw new OAuthError(OAuthErrorCode.InvalidToken, 'invalid token');
    return { token, clientId: 'client', scopes: scopes.split(','), expiresAt: Math.floor(Date.now() / 1000) + 3600, extra: { user_id: user } };
  },
};

/** The notes server of the Go vectors: one read and one write tool, and the extra origin https://app.notes.example. */
export function notesServer(perMinute: number): Server {
  const annotations = (readOnly: boolean) => ({ readOnly, destructive: !readOnly, idempotent: false, openWorld: false });
  const tool = (name: string, readOnly: boolean) =>
    newTool({ name, title: name, description: `${name}.`, inputSchema: { type: 'object' }, annotations: annotations(readOnly) }, async () => ({}));
  return newServer({
    name: 'notes', title: 'Notes', version: 'test', resource: 'https://notes.example/mcp', issuer: 'https://sso.example',
    verifier: vectorVerifier, origins: ['https://app.notes.example'], tools: [tool('notes_list', true), tool('notes_write', false)],
    ...(perMinute > 0 && { rateLimit: { rate: perMinute / 60, burst: perMinute } }),
  });
}

/** Sends one vector request to server, with the headers Go's runner sets. */
export function send(server: Server, input: Record<string, unknown>): Promise<Response> {
  return server.fetch(new Request(`https://notes.example${str(input, 'path')}`, {
    method: str(input, 'method'), body: str(input, 'body'),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(input.headers as Record<string, string>) },
  }));
}

/**
 * What tronc-ts keeps of an mcp_http answer. The status, the Origin
 * refusals, the 405 and the metadata are byte for byte Go's. A 401 or 403
 * comes from the official SDK's bearer gate, which writes an RFC 6750 JSON
 * body, adds error_description and error="invalid_token" to a missing
 * token, and orders the challenge differently; so for those only the
 * challenge's scope and resource_metadata are compared.
 */
export function portableHttp(value: Record<string, unknown>): Record<string, unknown> {
  const challenge = str(value, 'www_authenticate');
  if (!challenge) return value;
  const params = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
  return { status: value.status, scope: params.scope, resource_metadata: params.resource_metadata };
}

/** Sends requests GETs as user and records in want how many passed and what the refusal looked like. */
export async function spendBucket(server: Server, user: string, requests: number, want: RateWant): Promise<void> {
  for (let i = 0; i < requests; i++) {
    const response = await send(server, { method: 'GET', path: '/mcp', headers: { Authorization: `Bearer ${user}|notes.read` } });
    if (response.status !== 429) {
      want.allowed[user] = (want.allowed[user] ?? 0) + 1;
      continue;
    }
    Object.assign(want, {
      refused_status: 429, refused_content_type: response.headers.get('Content-Type') ?? '',
      refused_body: await response.text(), retry_after: response.headers.has('Retry-After'),
    });
  }
}
