import { CONFIRM_INPUT, STATUS_DECLINED, STATUS_PENDING } from '../mcp';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { answering, call, connect, decode, text, type ClientOptions } from './client';
import { assert } from './checks';
import type { Config, ConfirmCase } from './index';

/** The part of a sensitive tool's result the checks read. */
interface Status {
  status: string;
  confirm_url?: string;
}

/** An accepting answer to a confirmation. */
const ACCEPT = { [CONFIRM_INPUT]: { action: 'accept', content: { [CONFIRM_INPUT]: true } } };

/** Runs fn with a fresh client and closes it. */
async function using<T>(cfg: Config, opts: ClientOptions, fn: (c: Awaited<ReturnType<typeof connect>>) => Promise<T>): Promise<T> {
  const client = await connect(cfg.url, await cfg.token(), opts);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

/** Checks a client that cannot be asked gets a pending status and a confirm link, and nothing ran. */
export async function checkLink(cfg: Config, c: ConfirmCase, opts: ClientOptions): Promise<void> {
  const { args, runs } = await c.setup();
  const out = await using(cfg, opts, async (client) => decode<Status>(await call(client, c.tool, args)));
  assert(out.status === STATUS_PENDING && out.confirm_url?.includes('action=') && runs() === 0,
    `want ${STATUS_PENDING} with a confirm_url and no run, got ${JSON.stringify(out)} and ${runs()} runs`);
}

/** Checks a decline asks once and runs nothing. */
export async function checkDecline(cfg: Config, c: ConfirmCase): Promise<void> {
  const { args, runs } = await c.setup();
  const asked = { count: 0 };
  const out = await using(cfg, { elicit: answering('decline', asked) }, async (client) => decode<Status>(await call(client, c.tool, args)));
  assert(out.status === STATUS_DECLINED && asked.count === 1 && runs() === 0,
    `want one question, status declined and no run, got ${asked.count} questions, ${JSON.stringify(out)}, ${runs()} runs`);
}

/** Sends one tools/call round by hand, with an optional state and answer. */
function round(client: Awaited<ReturnType<typeof connect>>, tool: string, args: Record<string, unknown>, requestState?: string) {
  const params = { name: tool, arguments: args, ...(requestState !== undefined && { requestState, inputResponses: ACCEPT }) };
  return client.request({ method: 'tools/call', params }, { allowInputRequired: true }) as Promise<
    CallToolResult & { resultType?: string; requestState?: string; inputRequests?: unknown }
  >;
}

/** Answers a question by hand, checks the action ran once, then replays the answer and checks it did not run again. */
export async function checkAccept(cfg: Config, c: ConfirmCase): Promise<void> {
  const { args, runs } = await c.setup();
  await using(cfg, { elicit: answering('accept', { count: 0 }), manual: true }, async (client) => {
    const question = await round(client, c.tool, args);
    assert(question.inputRequests && question.requestState, `a client that can elicit must get input_required, got ${JSON.stringify(question)}`);
    const done = await round(client, c.tool, args, question.requestState);
    assert(!done.isError && runs() === 1, `an accepted confirmation must run once, got ${text(done)}, ${runs()} runs`);
    const replay = await round(client, c.tool, args, question.requestState);
    assert(replay.isError && runs() === 1, `a replayed confirmation must fail and run nothing, got ${JSON.stringify(replay)}, ${runs()} runs`);
  });
}

/** Checks a confirm link id cannot be passed off as a signed state. */
export async function checkForgery(cfg: Config, c: ConfirmCase): Promise<void> {
  const { args, runs } = await c.setup();
  const out = await using(cfg, {}, async (client) => decode<Status>(await call(client, c.tool, args)));
  const id = new URL(out.confirm_url ?? 'http://x').searchParams.get('action') ?? '';
  await using(cfg, { manual: true }, async (client) => {
    const forged = await round(client, c.tool, args, id);
    assert(forged.isError && runs() === 0, `a forged state must fail and run nothing, got ${JSON.stringify(forged)}, ${runs()} runs`);
  });
}
