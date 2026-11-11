import { createRemoteJWKSet, errors as jose, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { EXTRA_ACTOR, EXTRA_SUBJECT, EXTRA_USER_ID } from './caller';

/** The leeway on time claims, matching porte's JWT check. */
const CLOCK_SKEW_SECONDS = 30;

/** What a verified Registre token asserts. */
export interface Claims {
  subject: string;
  scopes: string[];
  /** act.sub on a delegated (RFC 8693) token, empty otherwise. */
  actor: string;
  /** The client the token was issued to; on a delegated token, the exchanging client. */
  clientId: string;
  audience: string[];
  expiresAt: number;
  /** Every claim, for an app that reads email or name to provision an account. */
  payload: JWTPayload;
}

/** Describes the resource server. */
export interface VerifierConfig {
  /** Registre's issuer URL, https://sso.facile.studio. It must equal the token's iss byte for byte. */
  issuer: string;
  /** The canonical MCP resource URI, such as https://glouton.facile.studio/mcp. */
  resource: string;
  /** The app's scope namespace, such as "glouton". A write grant implies read. */
  scopePrefix: string;
  /**
   * The app's OIDC client id, the aud of tokens Bulle exchanges today. A token
   * naming it instead of resource is accepted only if it is a delegation (act).
   */
  audience?: string;
  /**
   * Maps the claims to the app's user id, creating the account first when the
   * app provisions on first use. undefined refuses the token; a throw is a 500.
   * Without it the user id is the sub.
   */
  resolveUser?: (claims: Claims) => Promise<string | undefined>;
  /** Overrides the key set, for tests. Otherwise discovery finds Registre's JWKS. */
  keys?: JWTVerifyGetKey;
  /** Receives the reason a token was refused, never the token. */
  onRefuse?: (reason: string) => void;
}

/**
 * Performs Registre discovery and returns the SDK token verifier for cfg, the
 * TypeScript counterpart of porte/mcpauth.Verifier. It checks the RS256
 * signature against Registre's JWKS, iss, exp, nbf, iat and an audience bound
 * to the resource, then resolves the person. Every refusal is the same
 * invalid_token, so the client learns nothing about which check failed.
 */
export async function registreVerifier(cfg: VerifierConfig): Promise<OAuthTokenVerifier> {
  if (!URL.canParse(cfg.resource) || !/^[a-z0-9_]+$/.test(cfg.scopePrefix) || !cfg.issuer) {
    throw new Error('mcp: the verifier needs an issuer, an absolute resource and a lowercase scope prefix');
  }
  const keys = cfg.keys ?? (await discoverKeys(cfg.issuer));
  const refuse = (reason: string) => {
    cfg.onRefuse?.(reason);
    return new OAuthError(OAuthErrorCode.InvalidToken, 'invalid token');
  };
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const claims = await verifyClaims(token, keys, cfg, refuse);
      let userId: string | undefined;
      try {
        userId = cfg.resolveUser ? await cfg.resolveUser(claims) : claims.subject;
      } catch {
        throw new OAuthError(OAuthErrorCode.ServerError, 'token verification is unavailable');
      }
      if (!userId) throw refuse('no account for this subject');
      return authInfo(token, claims, userId, cfg.resource);
    },
  };
}

/** Fetches Registre's discovery document and returns its remote key set. */
async function discoverKeys(issuer: string): Promise<JWTVerifyGetKey> {
  const response = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
  const doc = (await response.json()) as { issuer?: string; jwks_uri?: string };
  if (!response.ok || doc.issuer !== issuer || !doc.jwks_uri) {
    throw new Error(`mcp: ${issuer} serves no matching discovery document`);
  }
  return createRemoteJWKSet(new URL(doc.jwks_uri));
}

/** Verifies the token and applies the one audience rule jose cannot express. */
async function verifyClaims(
  token: string, keys: JWTVerifyGetKey, cfg: VerifierConfig, refuse: (reason: string) => OAuthError,
): Promise<Claims> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      issuer: cfg.issuer,
      audience: cfg.audience ? [cfg.resource, cfg.audience] : cfg.resource,
      algorithms: ['RS256'],
      clockTolerance: CLOCK_SKEW_SECONDS,
      requiredClaims: ['exp', 'sub'],
    }));
  } catch (err) {
    if (unavailable(err)) throw new OAuthError(OAuthErrorCode.ServerError, 'token verification is unavailable');
    throw refuse(err instanceof Error ? err.message : 'unverifiable');
  }
  const claims = toClaims(payload, cfg.scopePrefix);
  if (!claims.audience.includes(cfg.resource) && claims.actor === '') {
    throw refuse('the app audience is accepted on delegated tokens only');
  }
  return claims;
}

/** Reports whether err says Registre's keys could not be reached, rather than the token being bad. */
function unavailable(err: unknown): boolean {
  if (err instanceof jose.JWKSTimeout || err instanceof jose.JWKSInvalid) return true;
  return !(err instanceof jose.JOSEError);
}

/** Reads the claims a tool call needs from a verified payload. */
function toClaims(payload: JWTPayload, prefix: string): Claims {
  const scopes = typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : [];
  if (scopes.includes(`${prefix}.write`) && !scopes.includes(`${prefix}.read`)) scopes.push(`${prefix}.read`);
  const act = payload.act as { sub?: unknown } | undefined;
  return {
    subject: payload.sub ?? '',
    scopes,
    actor: typeof act?.sub === 'string' ? act.sub : '',
    clientId: typeof payload.client_id === 'string' ? payload.client_id : '',
    audience: typeof payload.aud === 'string' ? [payload.aud] : (payload.aud ?? []),
    expiresAt: payload.exp ?? 0,
    payload,
  };
}

/** The SDK's view of a verified token. */
function authInfo(token: string, claims: Claims, userId: string, resource: string): AuthInfo {
  return {
    token,
    clientId: claims.clientId,
    scopes: claims.scopes,
    expiresAt: claims.expiresAt,
    resource: new URL(resource),
    extra: { [EXTRA_USER_ID]: userId, [EXTRA_ACTOR]: claims.actor, [EXTRA_SUBJECT]: claims.subject },
  };
}
