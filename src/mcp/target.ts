import { createHash } from 'node:crypto';

/**
 * Fingerprints the fields of a target for Kind.fingerprint: the hex of the
 * first 16 bytes of SHA-256 over the fields joined by NUL, byte for byte the
 * Go tronc/mcp Digest, so the apps of both languages agree on a digest.
 */
export function digest(...fields: string[]): string {
  return createHash('sha256').update(fields.join('\0')).digest().subarray(0, 16).toString('hex');
}
