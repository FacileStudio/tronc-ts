import { safeUpgradeUrl } from '../mcp/upgrade';

/** Every failure to get an answer from Bulle: a network error, a timeout, a redirect, a 5xx or an unreadable body. */
export class UnreachableError extends Error {
  /** Builds the failure with what went wrong and its cause. */
  constructor(message: string, cause?: unknown) {
    super(`bulle: unreachable: ${message}`, { cause });
    this.name = 'UnreachableError';
  }
}

/**
 * Bulle's 402: the plan has no AI access. message and upgradeUrl are for the
 * person; upgradeUrl is empty unless it is a same-origin path or an https URL.
 * key is the entitlement the answer names, when it names one.
 */
export class PlanRequired extends Error {
  readonly upgradeUrl: string;
  readonly key: string;

  /** Builds the refusal from Bulle's fields, dropping an unsafe upgrade page. */
  constructor(fields: ErrorFields) {
    super(fields.message);
    this.name = 'PlanRequired';
    this.upgradeUrl = safeUpgradeUrl(fields.upgrade_url) ? fields.upgrade_url : '';
    this.key = fields.key;
  }
}

/** Any other 4xx answer, with its status and Bulle's error code and message. 429 is the daily cap, 409 a batch already running. */
export class StatusError extends Error {
  readonly status: number;
  readonly code: string;

  /** Builds the refusal from the status and Bulle's fields. */
  constructor(status: number, fields: ErrorFields) {
    super(fields.message);
    this.name = 'StatusError';
    this.status = status;
    this.code = fields.code;
  }
}

/** Thrown before any call when a path segment is empty, a dot segment, or longer than 200 bytes. */
export class BadSegmentError extends Error {
  /** Builds the refusal. */
  constructor() {
    super('bulle: invalid path segment');
    this.name = 'BadSegmentError';
  }
}

/** The fields of an error body Bulle answers with. */
export interface ErrorFields {
  code: string;
  message: string;
  upgrade_url: string;
  key: string;
}

const NO_FIELDS: ErrorFields = { code: '', message: '', upgrade_url: '', key: '' };
const FIELD_NAMES = ['code', 'message', 'upgrade_url', 'key'] as const;

/** value's string fields, or undefined when value is not an object or one of them is not a string, as Go's decoder refuses it. */
function fieldsOf(value: unknown): ErrorFields | undefined {
  if (value === null) return { ...NO_FIELDS };
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const fields = { ...NO_FIELDS };
  for (const name of FIELD_NAMES) {
    const field = (value as Record<string, unknown>)[name];
    if (typeof field === 'string') fields[name] = field;
    else if (field !== undefined && field !== null) return undefined;
  }
  return fields;
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
  const wrapped = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).error : undefined;
  if (wrapped !== undefined) {
    const fields = fieldsOf(wrapped);
    if (fields) return fields;
    if (typeof wrapped === 'string') return { ...NO_FIELDS, message: wrapped };
  }
  return fieldsOf(body) ?? { ...NO_FIELDS };
}

/** The error a non-2xx answer becomes, or undefined for a 2xx, like Go bulle's answer. */
export function failureOf(status: number, raw: string): Error | undefined {
  if (status >= 500) return new UnreachableError(`answered ${status}`);
  if (status === 402) return new PlanRequired(errorFields(raw));
  if (status >= 400) return new StatusError(status, errorFields(raw));
  if (status < 200 || status >= 300) return new UnreachableError(`answered ${status}`);
  return undefined;
}
