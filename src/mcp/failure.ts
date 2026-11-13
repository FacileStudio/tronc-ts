import { troncErrorOf } from './errors';
import { safeUpgradeUrl } from './upgrade';

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
  'unavailable',
]);

/**
 * A plan refusal from outside tronc, such as porte's forfait limit error:
 * the feature the plan refused and where to upgrade, empty when there is no
 * page. It is Go mcp.PlanLimit.
 */
export interface PlanLimit extends Error {
  planLimit(): { feature: string; upgradeUrl: string };
}

/** The first PlanLimit along err's cause chain, like Go errors.As, or undefined. */
function planLimitOf(err: unknown): PlanLimit | undefined {
  for (let seen = 0; err instanceof Error && seen < 32; seen++, err = err.cause) {
    if (typeof (err as Partial<PlanLimit>).planLimit === 'function') return err as PlanLimit;
  }
  return undefined;
}

/**
 * Turns a service error into one a model can act on, like Go mcp.Failure. A
 * bad argument or a missing precondition keeps its message. A missing record
 * keeps its message plus hint, which should name the tool that lists valid
 * ids. A plan refusal, a payment_required TroncError or a PlanLimit, keeps
 * its message and names its upgrade page when it is safe to show. An
 * unavailable dependency keeps its message, which says what is down.
 * Anything else becomes ERR_UNAVAILABLE, so internal detail stays out of the
 * result.
 */
export function failure(cause: unknown, hint = ''): ToolFailure {
  if (cause instanceof ToolFailure) return cause;
  const limit = planLimitOf(cause)?.planLimit();
  if (limit) return new ToolFailure(upgrade(`the plan limit for ${limit.feature} is reached`, limit.upgradeUrl));
  const err = troncErrorOf(cause);
  if (!err) return new ToolFailure(ERR_UNAVAILABLE);
  if (err.code === 'not_found') return new ToolFailure(`${sentence(err.message)}. ${hint}`.trim());
  if (ACTIONABLE.has(err.code)) return new ToolFailure(sentence(err.message));
  if (err.code === 'payment_required') return new ToolFailure(upgrade(err.message, err.upgradeUrl ?? ''));
  return new ToolFailure(ERR_UNAVAILABLE);
}

/** Capitalises the first character of a service message. */
function sentence(message: string): string {
  return message.replace(/^./su, (first) => first.toUpperCase());
}

/** A plan refusal's message followed by its upgrade page, when it is safe to show. */
function upgrade(message: string, link: string): string {
  const text = sentence(message).replace(/\.$/, '');
  return safeUpgradeUrl(link) ? `${text}. Upgrade at ${link}` : `${text}.`;
}
