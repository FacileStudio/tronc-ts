import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorResponse, TroncError } from '../mcp';

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

/** One runner per ported subject: it turns a case's input into the value its want describes. */
const RUNNERS: Record<string, Runner> = {
  errors: async (input) => {
    const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined);
    const known = new TroncError(str('code') ?? '', str('message') ?? '', { cause: str('cause'), upgradeUrl: str('upgrade_url') });
    const err = input.raw ? new Error(str('message')) : input.wrapped ? new Error('wrapped', { cause: known }) : known;
    const response = errorResponse(err);
    return { status: response.status, content_type: response.headers.get('Content-Type'), body: await response.text() };
  },
};

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
    for (const vector of file.cases) {
      test(`${file.subject}/${vector.name}`, async () => {
        expect(await RUNNERS[file.subject]!(vector.input)).toEqual(vector.want);
      });
    }
  }
});
