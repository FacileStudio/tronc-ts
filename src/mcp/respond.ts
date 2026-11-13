import { envelope, troncErrorOf } from './errors';

/** JSON as Go's encoder writes it: <, >, &, U+2028 and U+2029 escaped, and a trailing newline. */
function goJson(value: unknown): string {
  const escapes: Record<string, string> = { '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029' };
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => escapes[c]!) + '\n';
}

/** The JSON response for err, with its status and any extra headers, byte for byte Go httpjson.WriteError. */
export function errorResponse(err: unknown, headers: Record<string, string> = {}): Response {
  const status = troncErrorOf(err)?.status ?? 500;
  return new Response(goJson(envelope(err)), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}

/** A plain-text refusal, as Go http.Error writes it for the MCP gate. */
export function textResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
  });
}
