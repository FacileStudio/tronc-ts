import { RUN_STATES, type RunState } from './types';

/** The query naming app and space, each left out when empty. */
export function scope(app: string, space: string): Record<string, string> {
  const query: Record<string, string> = {};
  if (app) query.app = app;
  if (space) query.space_id = space;
  return query;
}

/** Maps Bulle's run status: waiting, or running with a call held, is an approval; finished is done; error, stopped and interrupted are failures. */
export function runState(status: string | undefined, pending: number): RunState {
  if (status === 'waiting' || (status === 'running' && pending > 0)) return RUN_STATES.needsApproval;
  if (status === 'finished') return RUN_STATES.done;
  if (status === 'error' || status === 'stopped' || status === 'interrupted') return RUN_STATES.failed;
  return RUN_STATES.running;
}

/** raw when it is an http or https link with a host and no credentials, otherwise ''. */
export function webLink(raw: string | undefined): string {
  const match = /^(https?):\/\/([^/?#]*)/i.exec(raw ?? '');
  if (!match || !match[2] || match[2].includes('@') || !URL.canParse(raw!)) return '';
  return raw!;
}
