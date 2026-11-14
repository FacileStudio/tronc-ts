import { safeUpgradeUrl } from '../mcp/upgrade';

/**
 * Every failure to get an answer from Bulle: a network error, a timeout, a
 * redirect, a 5xx or an unreadable body. A StatusError with a 5xx status, a
 * 503 that names a Retry-After, is an instance too, like Go's StatusError
 * that wraps ErrUnreachable.
 */
export class UnreachableError extends Error {
  /** Builds the failure with what went wrong and its cause. */
  constructor(message: string, cause?: unknown) {
    super(`bulle: unreachable: ${message}`, { cause });
    this.name = 'UnreachableError';
  }

  /** Reports whether value is an UnreachableError or a 5xx StatusError. */
  static [Symbol.hasInstance](value: unknown): boolean {
    return Function.prototype[Symbol.hasInstance].call(this, value) || (this === UnreachableError && value instanceof StatusError && value.status >= 500);
  }
}

/**
 * Bulle's 402: the plan has no AI access. message and upgradeUrl are for the
 * person; upgradeUrl is empty unless it is a same-origin path or an https URL.
 * key is the entitlement the answer names, when it names one, and limit the
 * plan's limit on it, 0 when the answer names none.
 */
export class PlanRequired extends Error {
  readonly upgradeUrl: string;
  readonly key: string;
  readonly limit: number;

  /** Builds the refusal from Bulle's fields, dropping an unsafe upgrade page. */
  constructor(fields: ErrorFields) {
    super(fields.message);
    this.name = 'PlanRequired';
    this.upgradeUrl = safeUpgradeUrl(fields.upgrade_url) ? fields.upgrade_url : '';
    this.key = fields.key;
    this.limit = fields.limit;
  }
}

/**
 * Any other 4xx answer, with its status and Bulle's error code and message,
 * or a 503 that names a Retry-After. 429 is the daily cap, 409 a batch
 * already running. retryAfterMs is the wait in milliseconds the answer's
 * Retry-After header asks for on a 429 or a 503, whole seconds capped at a
 * day, 0 when it names none. A 503 StatusError is also an UnreachableError.
 */
export class StatusError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterMs: number;

  /** Builds the refusal from the status, Bulle's fields and the Retry-After wait. */
  constructor(status: number, fields: ErrorFields, retryAfterMs = 0) {
    super(fields.message);
    this.name = 'StatusError';
    this.status = status;
    this.code = fields.code;
    this.retryAfterMs = retryAfterMs;
  }
}

const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

const INT64_MAX = 2n ** 63n - 1n;

const IMF_FIXDATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Reads a Retry-After value, delay seconds or an HTTP date (IMF-fixdate), as
 * the wait from now in milliseconds, at most a day, like Go bulle's
 * retryAfter. A missing, unreadable or past value is 0.
 */
export function retryAfterMs(value: string | null, now = Date.now()): number {
  const text = (value ?? '').trim();
  if (/^[+-]?\d+$/.test(text) && BigInt(text) <= INT64_MAX && BigInt(text) >= -INT64_MAX - 1n) {
    return Math.min(Math.max(Number(text), 0) * 1000, MAX_RETRY_AFTER_MS);
  }
  const when = IMF_FIXDATE.test(text) ? Date.parse(text) : NaN;
  if (Number.isNaN(when) || when <= now) return 0;
  return Math.min(Math.round((when - now) / 1000) * 1000, MAX_RETRY_AFTER_MS);
}

/** Thrown before any call when a path segment is empty, a dot segment, or longer than 200 bytes. */
export class BadSegmentError extends Error {
  /** Builds the refusal. */
  constructor() {
    super('bulle: invalid path segment');
    this.name = 'BadSegmentError';
  }
}

/** Thrown by Client.decideAI before any call when the request names no person to act for. */
export class NoActingForError extends Error {
  /** Builds the refusal. */
  constructor() {
    super('bulle: decideAI needs the email of the user it acts for');
    this.name = 'NoActingForError';
  }
}

/** The fields of an error body Bulle answers with. */
export interface ErrorFields {
  code: string;
  message: string;
  upgrade_url: string;
  key: string;
  limit: number;
}

const NO_FIELDS: ErrorFields = { code: '', message: '', upgrade_url: '', key: '', limit: 0 };

/** The value of key in object, matched without regard to case like Go's decoder, the last match winning. */
function field(object: Record<string, unknown>, key: string): unknown {
  let value: unknown;
  for (const name of Object.keys(object)) if (name.toLowerCase() === key) value = object[name];
  return value;
}

/** Reports whether value fits an ErrorFields field of the type of zero, as Go's decoder accepts it: null, or the same type, an integer for limit. */
function fits(value: unknown, zero: string | number): boolean {
  if (value === undefined || value === null) return true;
  return typeof zero === 'string' ? typeof value === 'string' : Number.isSafeInteger(value);
}

/** value's fields, or undefined when value is not an object or a field has the wrong type, as Go's decoder refuses it. */
function fieldsOf(value: unknown): ErrorFields | undefined {
  if (value === null) return { ...NO_FIELDS };
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const fields: Record<string, string | number> = { ...NO_FIELDS };
  for (const [name, zero] of Object.entries(NO_FIELDS)) {
    const given = field(value as Record<string, unknown>, name);
    if (!fits(given, zero)) return undefined;
    if (given !== undefined && given !== null) fields[name] = given as string | number;
  }
  return fields as unknown as ErrorFields;
}

/**
 * Reads an error body in tronc's {"error":{...}} envelope, as {"error":"..."},
 * or bare with the fields at the top level, like Go bulle's envelope. A body
 * that is none of these gives empty fields.
 */
export function errorFields(raw: string): ErrorFields {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ...NO_FIELDS };
  }
  const wrapped = typeof body === 'object' && body !== null && !Array.isArray(body) ? field(body as Record<string, unknown>, 'error') : undefined;
  if (wrapped !== undefined) {
    const fields = fieldsOf(wrapped);
    if (fields) return fields;
    if (typeof wrapped === 'string') return { ...NO_FIELDS, message: wrapped };
  }
  return fieldsOf(body) ?? { ...NO_FIELDS };
}

/** The error a non-2xx answer becomes, or undefined for a 2xx, like Go bulle's answer. retryAfter is the answer's Retry-After header. */
export function failureOf(status: number, raw: string, retryAfter: string | null = null): Error | undefined {
  const wait = retryAfterMs(retryAfter);
  if (status === 503 && wait > 0) return new StatusError(status, errorFields(raw), wait);
  if (status >= 500) return new UnreachableError(`answered ${status}`);
  if (status === 402) return new PlanRequired(errorFields(raw));
  if (status >= 400) return new StatusError(status, errorFields(raw), status === 429 ? wait : 0);
  if (status < 200 || status >= 300) return new UnreachableError(`answered ${status}`);
  return undefined;
}
