import { safeUpgradeUrl } from './upgrade';

/**
 * The suite error envelope, `{"error":{"code","message"}}`, and the codes a
 * service throws. It mirrors Go `github.com/FacileStudio/tronc/errors`.
 */

/** The HTTP status of each envelope code, as tronc/errors maps them. */
export const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  invalid_argument: 400,
  unauthenticated: 401,
  payment_required: 402,
  permission_denied: 403,
  not_found: 404,
  method_not_allowed: 405,
  already_exists: 409,
  failed_precondition: 412,
  resource_exhausted: 413,
  rate_limited: 429,
  internal: 500,
  unavailable: 503,
};

/** A failure a service reports with an envelope code. */
export class TroncError extends Error {
  readonly code: string;
  readonly upgradeUrl?: string;

  /** Builds an error with code, message, an optional cause and upgrade page; an unsafe upgrade page is dropped, as Go WithUpgradeURL does. */
  constructor(code: string, message: string, options: { cause?: unknown; upgradeUrl?: string } = {}) {
    super(message, { cause: options.cause });
    this.name = 'TroncError';
    this.code = code;
    if (options.upgradeUrl && safeUpgradeUrl(options.upgradeUrl)) this.upgradeUrl = options.upgradeUrl;
  }

  /** The HTTP status of the code, 500 for a code tronc does not know. */
  get status(): number {
    return STATUS_BY_CODE[this.code] ?? 500;
  }
}

/** A bad argument the caller can fix. */
export const invalid = (message: string) => new TroncError('invalid_argument', message);

/** A missing record. */
export const notFound = (message: string) => new TroncError('not_found', message);

/** A precondition that does not hold, such as a stale confirmation. */
export const failed = (message: string) => new TroncError('failed_precondition', message);

/** A failure the caller cannot fix; cause stays server side. */
export const internal = (message: string, cause?: unknown) => new TroncError('internal', message, { cause });

/** The first TroncError along err's cause chain, like Go errors.As, or undefined. */
export function troncErrorOf(err: unknown): TroncError | undefined {
  for (let seen = 0; err instanceof Error && seen < 32; seen++, err = err.cause) {
    if (err instanceof TroncError) return err;
  }
  return undefined;
}

/** The envelope body of err. An error with no TroncError in its cause chain hides behind `internal`; a cause never shows. */
export function envelope(cause: unknown): { error: { code: string; message: string; upgrade_url?: string } } {
  const err = troncErrorOf(cause);
  if (!err) {
    return { error: { code: 'internal', message: 'internal server error' } };
  }
  const body: { code: string; message: string; upgrade_url?: string } = { code: err.code, message: err.message };
  if (err.upgradeUrl && safeUpgradeUrl(err.upgradeUrl)) body.upgrade_url = err.upgradeUrl;
  return { error: body };
}
