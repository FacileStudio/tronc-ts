import { troncErrorOf, type TroncError } from './errors';

/** The message a model gets for a failure it cannot fix. */
export const ERR_UNAVAILABLE = 'the app could not finish this request. Retry once; if it fails again, tell the user';

/** An error whose message is meant for the model as is. */
export class ToolFailure extends Error {
  /** Builds a failure with the model-facing message. */
  constructor(message: string) {
    super(message);
    this.name = 'ToolFailure';
  }
}

/** The codes whose message a model may read as is. */
const ACTIONABLE = new Set([
  'invalid_argument',
  'failed_precondition',
  'already_exists',
  'permission_denied',
  'rate_limited',
  'resource_exhausted',
]);

/**
 * Turns a service error into one a model can act on, like Go mcp.Failure. A
 * bad argument or a missing precondition keeps its message. A missing record
 * keeps its message plus hint, which should name the tool that lists valid
 * ids. A plan refusal names its upgrade page. Anything else becomes
 * ERR_UNAVAILABLE, so internal detail stays out of the result.
 */
export function failure(cause: unknown, hint = ''): ToolFailure {
  if (cause instanceof ToolFailure) return cause;
  const err = troncErrorOf(cause);
  if (!err) return new ToolFailure(ERR_UNAVAILABLE);
  if (err.code === 'not_found') return new ToolFailure(`${sentence(err.message)}. ${hint}`.trim());
  if (ACTIONABLE.has(err.code)) return new ToolFailure(sentence(err.message));
  if (err.code === 'payment_required') return new ToolFailure(upgrade(err));
  return new ToolFailure(ERR_UNAVAILABLE);
}

/** Capitalises the first letter of a service message. */
function sentence(message: string): string {
  return message === '' ? message : message[0]!.toUpperCase() + message.slice(1);
}

/** A plan refusal's message followed by its upgrade page, when it has one. */
function upgrade(err: TroncError): string {
  const message = sentence(err.message).replace(/\.$/, '');
  return err.upgradeUrl ? `${message}. Upgrade at ${err.upgradeUrl}` : `${message}.`;
}
