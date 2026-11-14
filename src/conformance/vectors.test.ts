import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { omitEmpty, str } from './mcp';
import { Client, PlanRequired, StatusError, UnreachableError, BadSegmentError } from '../bulle';
import { digest, errorResponse, failure, stateKey, TroncError } from '../mcp';
import { notesServer, portableHttp, send, spendBucket, type RateWant } from './mcp';

interface Case {
  name: string;
  input: Record<string, unknown>;
  want: Record<string, unknown>;
}

interface VectorFile {
  source: string;
  subject: string;
  cases: Case[];
}

type Runner = (input: Record<string, unknown>) => Promise<unknown>;

const DIR = join(import.meta.dir, '../../testdata/vectors');

/** Go's HTTP chassis, which tronc-ts does not port: their vectors are listed, not run. */
const GO_ONLY = new Set(['json_decode', 'health', 'request_log', 'security_headers', 'client_ip', 'spa', 'inline_script_hashes']);


/** A Bulle client whose every call gets answer. */
function bulleAnswering(answer: Record<string, unknown>): Client {
  const fetcher = (async () => new Response(str(answer, 'body') ?? '', {
    status: answer.status as number,
    headers: {
      'Content-Type': 'application/json',
      ...(answer.location ? { Location: answer.location as string } : {}),
      ...(answer.retry_after ? { 'Retry-After': answer.retry_after as string } : {}),
    },
  })) as unknown as typeof fetch;
  return new Client({ url: 'https://bulle.example', token: async () => 'tok', fetch: fetcher });
}

/** Classifies a complete outcome as Go's bulle vectors do, with the optional Retry-After wait in seconds. */
function classifyBulle(err: unknown): Record<string, unknown> {
  if (err === undefined) return { kind: 'ok' };
  if (err instanceof PlanRequired) return omitEmpty({ kind: 'plan_required', message: err.message, upgrade_url: err.upgradeUrl, key: err.key, limit: err.limit });
  if (err instanceof StatusError) return omitEmpty({ kind: 'status', status: err.status, code: err.code, message: err.message, retry_after_seconds: err.retryAfterMs / 1000 });
  if (err instanceof UnreachableError) return { kind: 'unreachable' };
  return { kind: 'other' };
}

/** The error a mcp_failure input stands for: a PlanLimit wrapped once, a raw error, or a TroncError. */
function failureError(input: Record<string, unknown>): Error {
  const feature = str(input, 'plan_limit_feature');
  if (feature) {
    const limit = Object.assign(new Error('forfait: plan limit reached'), { planLimit: () => ({ feature, upgradeUrl: str(input, 'upgrade_url') ?? '' }) });
    return new Error('creating', { cause: limit });
  }
  if (input.raw) return new Error(str(input, 'message'));
  return new TroncError(str(input, 'code') ?? '', str(input, 'message') ?? '', { upgradeUrl: str(input, 'upgrade_url') });
}

/** One runner per ported subject: it turns a case's input into the value its want describes. */
const RUNNERS: Record<string, Runner> = {
  errors: async (input) => {
    const known = new TroncError(str(input, 'code') ?? '', str(input, 'message') ?? '', { cause: str(input, 'cause'), upgradeUrl: str(input, 'upgrade_url') });
    const err = input.raw ? new Error(str(input, 'message')) : input.wrapped ? new Error('wrapped', { cause: known }) : known;
    const response = errorResponse(err);
    return { status: response.status, content_type: response.headers.get('Content-Type'), body: await response.text() };
  },
  mcp_http: async (input) => {
    const response = await send(notesServer(0), input);
    const body = response.status === 405 ? '' : await response.text();
    return omitEmpty({
      status: response.status, content_type: response.headers.get('Content-Type') ?? '',
      www_authenticate: response.headers.get('WWW-Authenticate') ?? '', body,
    });
  },
  mcp_rate_limit: async (input) => {
    const server = notesServer(input.per_minute as number);
    const want: RateWant = { allowed: {}, refused_status: 0, refused_content_type: '', refused_body: '', retry_after: false };
    for (const user of input.users as string[]) await spendBucket(server, user, input.requests_each as number, want);
    return want;
  },
  mcp_digest: async (input) => ({ digest: digest(...(input.fields as string[])) }),
  mcp_state_key: async (input) => ({ key_hex: Buffer.from(stateKey(str(input, 'app')!, str(input, 'secret')!)).toString('hex') }),
  mcp_failure: async (input) => ({ text: failure(failureError(input), str(input, 'hint')).message }),
  bulle_errors: async (input) => {
    try {
      await bulleAnswering(input).complete('u1', { prompt: 'x' });
      return classifyBulle(undefined);
    } catch (err) {
      return classifyBulle(err);
    }
  },
  bulle_paths: async (input) => {
    let seen = '';
    const fetcher = (async (url: string) => {
      seen = url;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const client = new Client({ url: 'https://bulle.example', token: async () => 'tok', fetch: fetcher });
    try {
      await client.send('u1', { method: 'GET', segments: input.segments as string[], query: input.query as Record<string, string> });
    } catch (err) {
      if (err instanceof BadSegmentError) return { error: 'bad_segment' };
      throw err;
    }
    const [path, query] = seen.slice('https://bulle.example'.length).split('?');
    return omitEmpty({ path, query });
  },
};

/** Maps a subject's results and wants to what tronc-ts keeps of them; the identity for every other subject. */
const PORTABLE: Record<string, (value: Record<string, unknown>) => unknown> = { mcp_http: portableHttp };

const files: VectorFile[] = readdirSync(DIR)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(DIR, name), 'utf8')) as VectorFile);

describe('Go tronc conformance vectors', () => {
  test('every vector file has a runner or is listed as Go-only', () => {
    expect(files.length).toBeGreaterThan(0);
    const unknown = files.map((file) => file.subject).filter((subject) => !RUNNERS[subject] && !GO_ONLY.has(subject));
    expect(unknown).toEqual([]);
  });

  for (const file of files.filter((f) => RUNNERS[f.subject])) {
    const portable = PORTABLE[file.subject] ?? ((value) => value);
    for (const vector of file.cases) {
      test(`${file.subject}/${vector.name}`, async () => {
        const got = (await RUNNERS[file.subject]!(vector.input)) as Record<string, unknown>;
        expect(portable(got)).toEqual(portable(vector.want));
      });
    }
  }
});
