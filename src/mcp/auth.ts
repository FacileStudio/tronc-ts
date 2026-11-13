import { goJson } from './respond';

/** The RFC 9728 well-known prefix. */
export const WELL_KNOWN = '/.well-known/oauth-protected-resource';

/** The RFC 9728 document of an MCP resource. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_signing_alg_values_supported: string[];
}

/**
 * The RFC 9728 document for resource. resource must be the URL people type
 * into their client, because Claude refuses a document whose resource
 * differs. offline_access is not a resource scope and does not belong here.
 */
export function protectedResourceMetadata(resource: string, issuer: string, scopes: string[]): ProtectedResourceMetadata {
  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: scopes,
    bearer_methods_supported: ['header'],
    resource_signing_alg_values_supported: ['RS256'],
  };
}

/**
 * Where RFC 9728 places the metadata of resource: the well-known prefix
 * between the host and the path, so https://app.example/mcp maps to
 * https://app.example/.well-known/oauth-protected-resource/mcp.
 */
export function metadataUrl(resource: URL): string {
  return `${resource.origin}${WELL_KNOWN}${resource.pathname.replace(/\/$/, '')}`;
}

/** Serves the metadata document: JSON to GET, open to any origin, 204 to a preflight, 405 otherwise. */
export function metadataResponse(request: Request, doc: ProtectedResourceMetadata): Response {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { ...cors, Allow: 'GET, OPTIONS' } });
  }
  return new Response(goJson(doc), { headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' } });
}
