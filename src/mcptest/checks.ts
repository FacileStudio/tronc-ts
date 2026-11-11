import type { Tool as ListedTool } from '@modelcontextprotocol/client';
import { connect, post } from './client';
import type { Config } from './index';

/** A JSON-RPC tools/list request. */
export const LIST_TOOLS = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}';

/** The part of the RFC 9728 document the checks read. */
export interface Metadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
}

/** Throws message unless ok. */
export function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

/** The RFC 9728 location of resource's metadata. */
export function metadataUrlOf(resource: string): string {
  const url = new URL(resource);
  return `${url.origin}/.well-known/oauth-protected-resource${url.pathname.replace(/\/$/, '')}`;
}

/** Checks a call without a token gets a 401 naming the metadata, and that the metadata names the resource. */
export async function checkChallenge(cfg: Config): Promise<Metadata> {
  const response = await post(cfg.url, '', LIST_TOOLS);
  const challenge = response.headers.get('WWW-Authenticate') ?? '';
  const where = metadataUrlOf(cfg.url);
  assert(response.status === 401 && challenge.includes(`resource_metadata="${where}"`),
    `no token: want 401 with resource_metadata="${where}", got ${response.status} ${challenge}`);
  const doc = await fetch(where);
  assert(doc.ok, `metadata: want a JSON document at ${where}, got ${doc.status}`);
  const meta = (await doc.json()) as Metadata;
  assert(meta.resource === cfg.url && meta.authorization_servers?.length > 0,
    `metadata must name resource ${cfg.url} and an authorization server, got ${JSON.stringify(meta)}`);
  const count = meta.scopes_supported?.length ?? 0;
  assert(count === 1 || count === 2, `metadata must list a read scope and, unless every tool reads, a write scope; got ${meta.scopes_supported}`);
  return meta;
}

/** Checks the stateless endpoint refuses GET, and the Origin guard refuses a foreign site but not its own. */
export async function checkTransport(cfg: Config): Promise<void> {
  const get = await fetch(cfg.url, { headers: { Authorization: `Bearer ${await cfg.token()}`, Accept: 'text/event-stream' } });
  await get.arrayBuffer();
  assert(get.status === 405, `want 405 on GET, got ${get.status}`);
  const foreign = await post(cfg.url, await cfg.token(), LIST_TOOLS, { Origin: 'https://evil.example' });
  assert(foreign.status === 403, `want 403 for a foreign origin, got ${foreign.status}`);
  const own = await post(cfg.url, await cfg.token(), LIST_TOOLS, { Origin: new URL(cfg.url).origin });
  assert(own.status === 200, `the endpoint's own origin must pass, got ${own.status}`);
}

/** Lists the tools twice and checks the lists match, are sorted by name, and cache privately only. */
export async function listed(cfg: Config): Promise<ListedTool[]> {
  const client = await connect(cfg.url, await cfg.token());
  try {
    const first = await client.listTools();
    const again = await client.listTools();
    const names = first.tools.map((t) => t.name);
    const sorted = [...names].sort();
    assert(names.length > 0 && names.join() === sorted.join() && names.join() === again.tools.map((t) => t.name).join(),
      `tools/list must be non-empty, stable and sorted by name, got ${names}`);
    const scope = (first as { cacheScope?: string }).cacheScope;
    assert(scope === 'private', `tools/list must be cacheable privately only, got cacheScope ${scope}`);
    return first.tools;
  } finally {
    await client.close();
  }
}

/** Checks names, descriptions, annotations and schemas. */
export function checkTools(tools: ListedTool[], prefix: string): void {
  for (const tool of tools) {
    const a = tool.annotations;
    assert(tool.name.startsWith(prefix), `${tool.name}: name must start with ${prefix}`);
    assert(tool.title && tool.description, `${tool.name}: needs a title and a description`);
    assert(a && typeof a.destructiveHint === 'boolean' && typeof a.openWorldHint === 'boolean' && a.title,
      `${tool.name}: annotations must set every hint and a title, got ${JSON.stringify(a)}`);
    assert(!(a.readOnlyHint && a.destructiveHint), `${tool.name}: a read-only tool cannot be destructive`);
    checkSchema(`${tool.name} input`, tool.inputSchema);
    if (tool.outputSchema) checkSchema(`${tool.name} output`, tool.outputSchema);
  }
}

/** Checks a tool schema is a JSON object schema whose properties are schemas. */
function checkSchema(label: string, schema: unknown): void {
  const s = schema as { type?: unknown; properties?: unknown };
  const props = s?.properties;
  const valid = s?.type === 'object' && (props === undefined || (typeof props === 'object' && props !== null
    && Object.values(props).every((p) => typeof p === 'object' || typeof p === 'boolean')));
  assert(valid, `${label}: want a valid object schema, got ${JSON.stringify(schema)}`);
}

/** Checks a read-only token gets a 403 step-up challenge on a write tool and can still list tools. */
export async function checkWriteScope(cfg: Config, tools: ListedTool[], meta: Metadata): Promise<void> {
  const [read, write] = meta.scopes_supported;
  const writer = tools.find((t) => !t.annotations?.readOnlyHint);
  assert(!writer || write, `${writer?.name} writes, but the metadata lists no write scope`);
  if (!writer || !write) return;
  const token = await cfg.token(read!);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: writer.name, arguments: {} } });
  const response = await post(cfg.url, token, body);
  const challenge = response.headers.get('WWW-Authenticate') ?? '';
  assert(response.status === 403 && challenge.includes('error="insufficient_scope"') && challenge.includes(`scope="${write}"`),
    `read-only token on ${writer.name}: want 403 insufficient_scope for ${write}, got ${response.status} ${challenge}`);
  const list = await post(cfg.url, token, LIST_TOOLS);
  assert(list.status === 200, `a read-only token must list tools, got ${list.status}`);
}
