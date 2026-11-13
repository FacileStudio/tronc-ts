import { BadSegmentError, failureOf, NoActingForError, StatusError, UnreachableError } from './errors';
import { webLink, runState, scope } from './run';
import type { Batch, CompleteRequest, CompleteResponse, DecideRequest, DecideResponse, IdeaList, Run, RunStart } from './types';
import { byteLength, encodeQuery, pathEscape } from './escape';

const DEFAULT_TIMEOUT_MS = 20_000;

/** Names, on a decideAI call, the Bulle person the service acts for. */
export const ACTING_FOR_HEADER = 'X-Bulle-Acting-For';
const MAX_BODY = 1 << 20;

/** Returns the bearer token for user: an exchanged token (audience bulle) or a service key. */
export type TokenSource = (user: string) => Promise<string>;

/** Wires a Client. url and token are required. */
export interface Config {
  /** Bulle's origin, such as https://bulle.facile.studio. */
  url: string;
  token: TokenSource;
  /** Called after a 401 before the one retry, so token mints a new token instead of returning the cached one. */
  forget?: (user: string) => void | Promise<void>;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** How long one call may take; 20 s when unset. */
  timeoutMs?: number;
}

/** One call to Bulle's API. Segments follow /api/ and are escaped one by one, so an id holding a slash or a query stays one segment. */
export interface BulleRequest {
  method: string;
  segments: string[];
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** The base URL of cfg.url without trailing slashes; it throws unless it is an absolute http or https origin without credentials. */
function baseOf(raw: string): string {
  const base = raw.replace(/\/+$/, '');
  const parsed = URL.canParse(base) ? new URL(base) : undefined;
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || !parsed.host || parsed.username || parsed.password) {
    throw new Error('bulle: url must be an absolute http or https origin');
  }
  return base;
}

/** Reads at most MAX_BODY bytes of response as text, like Go's io.LimitReader. */
async function readBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let read = await reader.read(); !read.done && size < MAX_BODY; read = await reader.read()) {
    chunks.push(read.value);
    size += read.value.length;
  }
  await reader.cancel().catch(() => undefined);
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_BODY));
}

/** The JSON value of a 2xx body, undefined when it is empty. */
function decode(raw: string): unknown {
  if (raw.trim() === '') return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new UnreachableError('unreadable answer', err);
  }
}

/**
 * Calls Bulle's API as a person, the TypeScript counterpart of Go tronc/bulle.
 * A 402 throws PlanRequired, any other 4xx a StatusError, and a 5xx, a
 * redirect, a timeout or a network error an UnreachableError. A token source
 * failure is thrown as it is. A 401 retries once after Config.forget.
 */
export class Client {
  readonly base: string;
  private readonly http: typeof fetch;

  /** Checks cfg; it throws on a bad url or a missing token source. */
  constructor(private readonly cfg: Config) {
    this.base = baseOf(cfg.url);
    if (typeof cfg.token !== 'function') throw new Error('bulle: a token source is required');
    this.http = cfg.fetch ?? fetch;
  }

  /** Where the person continues a run's conversation in Bulle. */
  continueUrl(sessionId: string): string {
    return sessionId === '' ? this.base : `${this.base}/s/${pathEscape(sessionId)}`;
  }

  /** Sends req as user and returns the 2xx JSON answer, undefined when the body is empty. */
  async call<T = unknown>(user: string, req: BulleRequest): Promise<T | undefined> {
    return (await this.raw(user, req, true)) as T | undefined;
  }

  /** Sends req as user and ignores the 2xx body. */
  async send(user: string, req: BulleRequest): Promise<void> {
    await this.raw(user, req, false);
  }

  /** app's open ideas in space: a Bulle space id, the Registre shared space it mirrors, or '' for the personal space. */
  async ideas(user: string, app: string, space: string): Promise<IdeaList> {
    const list = await this.call<IdeaList>(user, { method: 'GET', segments: ['ideas'], query: scope(app, space) });
    return { generating: false, last_batch_at: null, ...list, ideas: list?.ideas ?? [] };
  }

  /** Starts a batch of app's ideas in space. Bulle caps it at three a day per person and app: 429 past that, 409 while one runs. */
  async generate(user: string, app: string, space: string): Promise<Batch> {
    const req = { method: 'POST', segments: ['ideas', 'generate'], query: scope(app, ''), body: { space_id: space } };
    return (await this.call<Batch>(user, req)) ?? { batch_id: '' };
  }

  /** Starts the idea as a background run. With a space, Bulle refuses an idea of another space. */
  async run(user: string, ideaId: string, space: string): Promise<RunStart> {
    const req = { method: 'POST', segments: ['ideas', ideaId, 'run'], query: scope('', space) };
    return (await this.call<RunStart>(user, req)) ?? { run_id: '', session_id: '', idea_id: '' };
  }

  /** Reads a run: its state, summary, outputs with only web links kept, and pending approvals. */
  async runStatus(user: string, runId: string): Promise<Run> {
    const run = (await this.call<Run>(user, { method: 'GET', segments: ['runs', runId] })) ?? ({} as Run);
    const outputs = (run.outputs ?? []).map((output) => ({ ...output, url: webLink(output.url) }));
    const approvals = run.pending_approvals ?? [];
    return {
      ...run, outputs, pending_approvals: approvals,
      state: runState(run.status, approvals.length), continue_url: this.continueUrl(run.session_id ?? ''),
    };
  }

  /** Approves or declines a call a run is waiting on. */
  async decide(user: string, runId: string, callId: string, approve: boolean): Promise<void> {
    await this.send(user, { method: 'POST', segments: ['runs', runId, 'approvals', callId], body: { approve } });
  }

  /** Hides an idea for good. */
  async dismiss(user: string, ideaId: string): Promise<void> {
    await this.send(user, { method: 'PATCH', segments: ['ideas', ideaId], body: { status: 'dismissed' } });
  }

  /**
   * One completion through POST /api/ai/complete with user's exchanged token.
   * space_id is sent only when spaceId is set, for a Bulle that knows it.
   */
  async complete(user: string, req: CompleteRequest, timeoutMs?: number): Promise<CompleteResponse> {
    const body = {
      system: req.system || undefined, prompt: req.prompt, input: req.input || undefined, schema: req.schema,
      max_tokens: req.maxTokens || undefined, space_id: req.spaceId || undefined,
    };
    const answer = await this.call<CompleteResponse>(user, { method: 'POST', segments: ['ai', 'complete'], body, timeoutMs });
    if (!answer) throw new UnreachableError('empty answer');
    return answer;
  }

  /**
   * One decision through POST /api/ai/decide, with a service key as token,
   * for the Bulle person named by actingFor. A blank actingFor throws
   * NoActingForError before any call.
   */
  async decideAI(user: string, req: DecideRequest): Promise<DecideResponse> {
    const actingFor = req.actingFor.trim();
    if (actingFor === '') throw new NoActingForError();
    const answer = await this.call<DecideResponse>(user, {
      method: 'POST', segments: ['ai', 'decide'], headers: { [ACTING_FOR_HEADER]: actingFor },
      body: { state: req.state, questions: req.questions },
    });
    if (!answer) throw new UnreachableError('empty answer');
    return answer;
  }

  private async raw(user: string, req: BulleRequest, parse: boolean): Promise<unknown> {
    const target = this.target(req);
    const payload = req.body === undefined ? undefined : JSON.stringify(req.body);
    try {
      return await this.once(user, req, target, payload, parse);
    } catch (err) {
      if (!this.cfg.forget || !(err instanceof StatusError && err.status === 401)) throw err;
      await this.cfg.forget(user);
      return this.once(user, req, target, payload, parse);
    }
  }

  private target(req: BulleRequest): string {
    const escaped = req.segments.map((segment) => {
      if (segment === '' || segment === '.' || segment === '..' || byteLength(segment) > 200) throw new BadSegmentError();
      return pathEscape(segment);
    });
    const query = encodeQuery(req.query ?? {});
    return `${this.base}/api/${escaped.join('/')}${query ? `?${query}` : ''}`;
  }

  private async once(user: string, req: BulleRequest, target: string, payload: string | undefined, parse: boolean): Promise<unknown> {
    const token = await this.cfg.token(user);
    const headers = new Headers(req.headers);
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('Accept', 'application/json');
    if (payload !== undefined) headers.set('Content-Type', 'application/json');
    let response: Response;
    let raw: string;
    try {
      response = await this.http(target, {
        method: req.method, headers, body: payload, redirect: 'manual',
        signal: AbortSignal.timeout(req.timeoutMs ?? this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      raw = await readBody(response);
    } catch (err) {
      throw new UnreachableError(err instanceof Error ? err.message : String(err), err);
    }
    const failure = failureOf(response.status, raw);
    if (failure) throw failure;
    return parse ? decode(raw) : undefined;
  }
}
