import {
  createMcpHandler,
  McpServer,
  requireBearerAuth,
  type AuthInfo,
  type McpHttpHandler,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import { consoleAudit, type AuditLogger } from './audit';
import { metadataResponse, metadataUrl, protectedResourceMetadata, WELL_KNOWN } from './auth';
import { TroncError } from './errors';
import { errorResponse, textResponse } from './respond';
import { DEFAULT_RATE_LIMIT, Limiter, RATE_LIMIT_EXCEEDED_BODY, rateKey, type RateLimit } from './ratelimit';
import type { Guard, Tool } from './tool';
import { checkTools } from './validate';

/** How long a client may keep the tool list when Options.listTtlMs is unset. */
export const DEFAULT_LIST_TTL_MS = 10 * 60 * 1000;

/** The results the 2026-07-28 revision lets a client cache. */
const CACHEABLE = ['tools/list', 'prompts/list', 'resources/list', 'resources/templates/list', 'resources/read', 'server/discover'] as const;

/** An app's MCP scopes. Write is unset on a read-only server. */
export interface Scopes {
  read: string;
  write?: string;
}

/** Describes one app's MCP server, as Go mcp.Options does. */
export interface Options {
  /** The app, such as "glouton": server name, tool prefix ("glouton_") and default scope prefix. */
  name: string;
  /** The human name of the app, such as "Glouton". */
  title: string;
  /** The server version reported to clients. */
  version: string;
  /** What a client shows its model about this server. */
  instructions?: string;
  /** The canonical URI people paste into their client; tokens are bound to it and its path is the endpoint. */
  resource: string;
  /** The authorization server named in the metadata, Registre. */
  issuer: string;
  /** Checks access tokens; registreVerifier in the suite. It must refuse tokens for any other resource. */
  verifier: OAuthTokenVerifier;
  /** Zero means name.read and name.write. A server whose tools are all read-only may set read alone. */
  scopes?: Scopes;
  /** Caps calls per person; DEFAULT_RATE_LIMIT when unset. */
  rateLimit?: RateLimit;
  /** Receives one record per write call and confirmation event. It never sees arguments. */
  audit?: AuditLogger;
  /** Receives an unexpected tool error, which the model sees only as ERR_UNAVAILABLE. */
  onError?: (err: unknown, tool: string) => void;
  /** Browser origins allowed besides the resource's own. Requests without Origin always pass. */
  origins?: string[];
  /** The curated tools, built with newTool. */
  tools: Tool[];
  /** How long a client may cache list results; the scope is always private. */
  listTtlMs?: number;
}

/** A router with Hono's `all(path, handler)` shape. */
export interface Router {
  all(path: string, handler: (c: { req: { raw: Request } }) => Promise<Response>): unknown;
}

/** A validated MCP server, ready to mount. */
export class Server {
  readonly path: string;
  readonly metadataUrl: string;
  private readonly handler: McpHttpHandler;
  private readonly gate: (request: Request) => Promise<AuthInfo | Response>;
  private readonly limiter: Limiter;
  private readonly origins: string[];

  /** Validates opts and the tools; it throws at boot rather than on the first call. */
  constructor(private readonly opts: Options & { scopes: Scopes }) {
    const resource = new URL(opts.resource);
    this.path = resource.pathname;
    this.metadataUrl = metadataUrl(resource);
    this.origins = [resource.origin, ...(opts.origins ?? [])];
    this.limiter = new Limiter(opts.rateLimit ?? DEFAULT_RATE_LIMIT);
    const factory = () => this.build();
    factory();
    this.handler = createMcpHandler(factory);
    this.gate = requireBearerAuth({ verifier: opts.verifier, requiredScopes: [opts.scopes.read], resourceMetadataUrl: this.metadataUrl });
  }

  /** The paths mount serves: the endpoint, its metadata and the bare well-known path. */
  get paths(): string[] {
    return [this.path, WELL_KNOWN + this.path.replace(/\/$/, ''), WELL_KNOWN];
  }

  /** Serves one request on any of paths; anything else is a 404. */
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === this.path) return this.endpoint(request);
    if (this.paths.includes(path)) return metadataResponse(request, this.metadata());
    return errorResponse(new TroncError('not_found', 'not found'));
  }

  /** Mounts the endpoint and metadata on router, outside any /api prefix and outside CSRF middleware. */
  mount(router: Router): void {
    for (const path of this.paths) router.all(path, (c) => this.fetch(c.req.raw));
  }

  /** The RFC 9728 document of the resource. */
  metadata() {
    const { read, write } = this.opts.scopes;
    return protectedResourceMetadata(this.opts.resource, this.opts.issuer, write ? [read, write] : [read]);
  }

  /** The MCP endpoint: Origin check, bearer token, rate limit, then the stateless SDK handler. */
  private async endpoint(request: Request): Promise<Response> {
    const origin = request.headers.get('Origin');
    if (origin && !this.origins.includes(origin)) {
      return textResponse(403, 'Forbidden: origin not allowed\n');
    }
    const auth = await this.gate(request);
    if (auth instanceof Response) return auth;
    const { ok, retryAfter } = this.limiter.allow(rateKey(auth));
    if (!ok) {
      return textResponse(429, RATE_LIMIT_EXCEEDED_BODY, { 'Retry-After': String(retryAfter) });
    }
    return this.handler.fetch(request, { authInfo: auth });
  }

  /** One SDK server instance with every tool, sorted by name; the SDK builds one per request. */
  private build(): McpServer {
    const ttlMs = this.opts.listTtlMs ?? DEFAULT_LIST_TTL_MS;
    const hint = { ttlMs, cacheScope: 'private' as const };
    const server = new McpServer(
      { name: this.opts.name, title: this.opts.title, version: this.opts.version },
      { instructions: this.opts.instructions, cacheHints: Object.fromEntries(CACHEABLE.map((m) => [m, hint])) },
    );
    const guard: Guard = {
      writeScope: this.opts.scopes.write ?? '',
      audit: this.opts.audit ?? consoleAudit,
      onError: this.opts.onError ?? ((err, tool) => console.error(`mcp: tool ${tool} failed`, err)),
    };
    const sorted = [...this.opts.tools].sort((a, b) => (a.spec.name < b.spec.name ? -1 : 1));
    for (const tool of sorted) tool.register(server, guard);
    return server;
  }
}

/** Validates opts and the tools, fills the defaults and returns the server, like Go mcp.New. */
export function newServer(opts: Options): Server {
  if (!/^[a-z][a-z0-9]*$/.test(opts.name)) throw new Error(`mcp: name "${opts.name}" must be lowercase letters and digits`);
  if (!opts.verifier) throw new Error('mcp: a token verifier is required');
  if (!opts.issuer) throw new Error('mcp: an issuer is required');
  if (!URL.canParse(opts.resource)) throw new Error(`mcp: resource "${opts.resource}" is not an absolute URI`);
  const scopes = opts.scopes ?? { read: `${opts.name}.read`, write: `${opts.name}.write` };
  if (!scopes.read) throw new Error('mcp: a read scope is required');
  checkTools(opts.tools, `${opts.name}_`, scopes.write);
  return new Server({ ...opts, scopes });
}

/** Builds the server and mounts it on router; see newServer and Server.mount. */
export function mount(router: Router, opts: Options): Server {
  const server = newServer(opts);
  server.mount(router);
  return server;
}
