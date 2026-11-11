/**
 * Mounts a remote MCP server on a fetch router: the official TypeScript SDK's
 * createMcpHandler, stateless (spec 2026-07-28, with the 2025 stateless
 * fallback), behind access tokens bound to the server's resource URI, with
 * the RFC 9728 metadata, an Origin check, a write-scope gate and a per-person
 * rate limit. It is the TypeScript counterpart of Go
 * github.com/FacileStudio/tronc/mcp and keeps its names and wire behaviour.
 */
export * from './audit';
export * from './auth';
export * from './caller';
export * from './confirm';
export * from './confirmations';
export * from './errors';
export * from './failure';
export * from './page';
export * from './pending';
export * from './ratelimit';
export * from './server';
export * from './tool';
export * from './validate';
export * from './verifier';
