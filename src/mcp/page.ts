import { ToolFailure } from './failure';

/** Caps the encoded size of one tool result at about 25,000 tokens, three bytes a token. */
export const RESULT_BUDGET = 75_000;

/** The response formats a read tool accepts in its response_format argument. */
export const FORMAT_CONCISE = 'concise';
export const FORMAT_DETAILED = 'detailed';

/** What a model sees when it sends a cursor this server did not mint. */
export const ERR_CURSOR = 'the cursor is not valid. Omit it to start again from the first page';

/** Reports whether format asks for the detailed form. Empty means concise; anything else throws. */
export function detailed(format: string | undefined): boolean {
  if (format === undefined || format === '' || format === FORMAT_CONCISE) return false;
  if (format === FORMAT_DETAILED) return true;
  throw new ToolFailure('response_format must be "concise" or "detailed"');
}

/** Makes an opaque cursor out of a position, any JSON value. */
export function encodeCursor(position: unknown): string {
  return Buffer.from(JSON.stringify(position)).toString('base64url');
}

/** Reads a cursor made by encodeCursor. Empty gives undefined; a malformed one throws ERR_CURSOR. */
export function decodeCursor<T>(cursor: string | undefined): T | undefined {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T;
  } catch {
    throw new ToolFailure(ERR_CURSOR);
  }
}

/** The JSON size of value in bytes, for fitCount. */
export function encodedSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/**
 * The largest n in [0, total] whose result, of size(n) bytes, stays within
 * RESULT_BUDGET. size must grow with n; a binary search calls it log(total) times.
 */
export function fitCount(total: number, size: (n: number) => number): number {
  let low = 0;
  let high = total;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (size(mid) > RESULT_BUDGET) high = mid - 1;
    else low = mid;
  }
  return low;
}

/** Cuts text to at most limit UTF-8 bytes on a character boundary and reports whether it cut. */
export function clip(text: string, limit: number): { text: string; clipped: boolean } {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return { text, clipped: false };
  let cut = Math.max(limit, 0);
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--;
  return { text: bytes.subarray(0, cut).toString('utf8').trim(), clipped: true };
}
