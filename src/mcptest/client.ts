import { Client, StreamableHTTPClientTransport, type CallToolResult, type ElicitResult } from '@modelcontextprotocol/client';

/** The newest protocol revision the kit speaks. */
export const MODERN = '2026-07-28';

/** Answers an elicitation request. */
export type Elicit = () => Promise<ElicitResult>;

/** Shapes a test client. */
export interface ClientOptions {
  /** Answers confirmation questions. Unset means the client does not advertise elicitation. */
  elicit?: Elicit;
  /** 'legacy' speaks the 2025 handshake; the default pins 2026-07-28. */
  version?: 'legacy' | typeof MODERN;
  /** Turns off the client's automatic MRTR retry, so a test can answer input_required results itself. */
  manual?: boolean;
}

/** Opens an SDK client on endpoint with token. The caller closes it. */
export async function connect(endpoint: string, token: string, opts: ClientOptions = {}): Promise<Client> {
  const client = new Client({ name: 'mcptest', version: '1' }, {
    capabilities: opts.elicit ? { elicitation: { form: {} } } : {},
    versionNegotiation: { mode: opts.version === 'legacy' ? 'legacy' : { pin: MODERN } },
    inputRequired: { autoFulfill: !opts.manual },
  });
  if (opts.elicit) client.setRequestHandler('elicitation/create', opts.elicit);
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

/** Runs one tool; a protocol error throws. */
export function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return client.callTool({ name, arguments: args });
}

/** Reads a result's structured content, throwing on an error result. */
export function decode<T>(result: CallToolResult): T {
  if (result.isError) throw new Error(`tool failed: ${text(result)}`);
  return result.structuredContent as T;
}

/** Joins a result's text content. */
export function text(result: CallToolResult): string {
  return (result.content ?? []).flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
}

/** An elicitation handler that answers action ("accept" or "decline") and counts the questions in asked.count. */
export function answering(action: 'accept' | 'decline', asked: { count: number }): Elicit {
  return async () => {
    asked.count++;
    return { action, content: { confirm: action === 'accept' } };
  };
}

/** The status and headers of one raw JSON-RPC POST. */
export async function post(endpoint: string, token: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    body,
  });
  await response.arrayBuffer();
  return response;
}
