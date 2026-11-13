const HEX = '0123456789ABCDEF';

/** Percent-encodes every UTF-8 byte of value outside keep, with uppercase hex. */
function escape(value: string, keep: RegExp, space: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(value)) {
    const char = String.fromCharCode(byte);
    if (byte < 0x80 && keep.test(char)) out += char;
    else if (byte === 0x20) out += space;
    else out += `%${HEX[byte >> 4]}${HEX[byte & 15]}`;
  }
  return out;
}

/** One path segment, byte for byte Go url.PathEscape: `$&+:=@` stay, `/;,?` and the rest are escaped. */
export function pathEscape(segment: string): string {
  return escape(segment, /[A-Za-z0-9\-_.~$&+:=@]/, '%20');
}

/** A query string, byte for byte Go url.Values.Encode: keys sorted, a space as `+`. */
export function encodeQuery(query: Record<string, string>): string {
  const keep = /[A-Za-z0-9\-_.~]/;
  return Object.keys(query)
    .sort()
    .map((key) => `${escape(key, keep, '+')}=${escape(query[key]!, keep, '+')}`)
    .join('&');
}

/** The UTF-8 length of value in bytes. */
export function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
