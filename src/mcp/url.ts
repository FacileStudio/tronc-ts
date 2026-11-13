/** Where a byte sits in a URL, as Go net/url's encoding modes name it. */
type Mode = 'host' | 'path' | 'fragment';

/** An absolute URL with an authority, as Go url.Parse reads it. path and fragment are Go's EscapedPath and EscapedFragment. */
export interface GoUrl {
  scheme: string;
  user: boolean;
  host: string;
  path: string;
  query?: string;
  fragment: string;
}

const HEX = '0123456789ABCDEF';

/** Reports whether Go leaves byte c unescaped in mode: the negation of url.shouldEscape. */
function keeps(c: number, mode: Mode): boolean {
  const char = String.fromCharCode(c);
  if (c < 0x80 && /[A-Za-z0-9\-_.~]/.test(char)) return true;
  if (mode === 'host') return `!$&'()*+,;=:[]<>"`.includes(char);
  if ('$&+,/:;=@'.includes(char)) return true;
  return mode === 'fragment' && '?!()*'.includes(char);
}

/** Reports whether c is an ASCII hex digit. */
function isHex(c: number | undefined): boolean {
  return c !== undefined && /[0-9A-Fa-f]/.test(String.fromCharCode(c));
}

/** The bytes s decodes to, or undefined where Go url.unescape fails: a bad % escape, or a host byte Go refuses. */
function unescape(s: string, mode: Mode): Uint8Array | undefined {
  const bytes = new TextEncoder().encode(s);
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]!;
    if (c !== 0x25) {
      if (mode === 'host' && c < 0x80 && !keeps(c, mode)) return undefined;
      out.push(c);
      continue;
    }
    if (!isHex(bytes[i + 1]) || !isHex(bytes[i + 2])) return undefined;
    const pair = String.fromCharCode(bytes[i + 1]!, bytes[i + 2]!);
    if (mode === 'host' && parseInt(pair[0]!, 16) < 8 && pair !== '25') return undefined;
    out.push(parseInt(pair, 16));
    i += 2;
  }
  return Uint8Array.from(out);
}

/** bytes with every byte Go escapes in mode written as %XX, like Go url.escape. */
function escape(bytes: Uint8Array, mode: Mode): string {
  let out = '';
  for (const c of bytes) out += keeps(c, mode) ? String.fromCharCode(c) : `%${HEX[c >> 4]}${HEX[c & 15]}`;
  return out;
}

/** Go's escaped form of raw in mode: raw itself when it is a valid encoding, like Go validEncoded, otherwise raw decoded and escaped again. */
function escaped(raw: string, mode: Mode): string | undefined {
  const decoded = unescape(raw, mode);
  if (!decoded) return undefined;
  const valid = [...new TextEncoder().encode(raw)].every((c) => `!$&'()*+,;=:@[]%`.includes(String.fromCharCode(c)) || keeps(c, mode));
  return valid ? raw : escape(decoded, mode);
}

/** The host of an authority without its userinfo, unescaped, or undefined where Go parseHost fails for http and https. */
function parseHost(host: string): string | undefined {
  if (host.lastIndexOf('[') > 0) return undefined;
  if (host.startsWith('[')) {
    const close = host.lastIndexOf(']');
    if (close < 0 || !/^(:\d*)?$/.test(host.slice(close + 1))) return undefined;
    return URL.canParse(`http://${host.slice(0, close + 1)}/`) && host.includes(':') ? host : undefined;
  }
  if (host.indexOf(':') !== host.lastIndexOf(':') || !/^[^:]*(:\d*)?$/.test(host)) return undefined;
  const decoded = unescape(host, 'host');
  return decoded ? new TextDecoder().decode(decoded) : undefined;
}

/**
 * Parses raw as Go url.Parse does for a scheme://authority URL, or returns
 * undefined where Go fails or raw has no authority. It covers what a link
 * check needs: control bytes, % escapes, the host, the port and Go's
 * re-escaping of the path and fragment.
 */
export function parseUrl(raw: string): GoUrl | undefined {
  if (/[\x00-\x1f\x7f]/.test(raw)) return undefined;
  const hash = raw.indexOf('#');
  const rest = hash < 0 ? raw : raw.slice(0, hash);
  const fragment = hash < 0 ? '' : escaped(raw.slice(hash + 1), 'fragment');
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?]*)([^?]*)(?:\?(.*))?$/s.exec(rest);
  if (!match || fragment === undefined) return undefined;
  const [, scheme, authority, rawPath, query] = match;
  const at = authority!.lastIndexOf('@');
  const host = parseHost(authority!.slice(at + 1));
  const path = escaped(rawPath!, 'path');
  if (host === undefined || path === undefined) return undefined;
  return { scheme: scheme!.toLowerCase(), user: at >= 0, host, path, query, fragment };
}

/** u written back as Go url.URL.String does, without its userinfo. */
export function urlString(u: GoUrl): string {
  const host = escape(new TextEncoder().encode(u.host), 'host');
  return `${u.scheme}://${host}${u.path}${u.query === undefined ? '' : `?${u.query}`}${u.fragment ? `#${u.fragment}` : ''}`;
}
