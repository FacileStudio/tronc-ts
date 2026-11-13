import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  PROTOCOL_VERSION_META_KEY,
  type ClientCapabilities,
  type InputRequiredResult,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { failed } from './errors';

/** The key of the one input request a confirmation makes. */
export const CONFIRM_INPUT = 'confirm';

/**
 * The first protocol version with multi round-trip requests. Older clients
 * reach a stateless server without a session, so a server-to-client
 * elicitation cannot run for them.
 */
export const MRTR_VERSION = '2026-07-28';

/** The refusal for a confirmation state this server did not sign, signed for someone else, or too long ago. */
export const ERR_CONFIRMATION = 'this confirmation is no longer valid. Call the tool again to ask the user afresh';

/** Builds the ERR_CONFIRMATION error, a failed_precondition. */
export const confirmationInvalid = () => failed(ERR_CONFIRMATION);

/**
 * The key that signs an app's confirmation state, derived from one of its
 * secrets: SHA-256 over `<app>-mcp-state:` followed by secret. It is Go
 * mcp.StateKey byte for byte, so questions signed before an app adopts it
 * still verify.
 */
export function stateKey(app: string, secret: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`${app}-mcp-state:${secret}`).digest());
}

/** What the person answered to a confirmation. */
export type Verdict = 'accepted' | 'declined';

/** The form the client shows: a single checkbox, ticked. */
const CONFIRM_SCHEMA = {
  type: 'object',
  properties: { [CONFIRM_INPUT]: { type: 'boolean', title: 'Confirm', default: true } },
  required: [CONFIRM_INPUT],
} as const;

/**
 * Reports whether the client asked for form elicitation on a protocol version
 * that lets a stateless server use it. An elicitation capability naming no
 * mode means form.
 */
export function canElicit(ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const version = envelope?.[PROTOCOL_VERSION_META_KEY];
  if (typeof version !== 'string' || version < MRTR_VERSION) return false;
  const elicitation = (envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined)?.elicitation;
  if (!elicitation) return false;
  return elicitation.form !== undefined || elicitation.url === undefined;
}

/** Reports whether a call retries an input_required result. A sensitive tool checks it first and calls resume. */
export function retrying(ctx: ServerContext): boolean {
  return ctx.mcpReq.requestState() !== undefined || Object.keys(ctx.mcpReq.inputResponses ?? {}).length > 0;
}

/**
 * Makes and checks the request state of a confirmation: the pending action,
 * the person and an expiry, signed with HMAC-SHA256, so a client cannot forge
 * a confirmation for an action the server did not ask about. The wire shape is
 * Go tronc/mcp's: `user.id.expiry.hexmac`.
 */
export class Signer {
  /** Signs with key; questions stay valid for ttlMs. */
  constructor(private readonly key: Uint8Array, private readonly ttlMs: number) {}

  /** The input_required result for pending action id. */
  ask(userId: string, id: string, message: string): InputRequiredResult {
    return inputRequired({
      inputRequests: { [CONFIRM_INPUT]: inputRequired.elicit({ message, requestedSchema: CONFIRM_SCHEMA as never }) },
      requestState: this.sign(userId, id, new Date(Date.now() + this.ttlMs)),
    });
  }

  /** Reads the retry of an ask: the pending action it was about and whether the person accepted. */
  answer(ctx: ServerContext, userId: string): { id: string; verdict: Verdict } {
    const state = ctx.mcpReq.requestState<string>();
    const id = this.verify(typeof state === 'string' ? state : '', userId, new Date());
    const result = ctx.mcpReq.inputResponses?.[CONFIRM_INPUT] as { action?: string; content?: Record<string, unknown> } | undefined;
    if (!result || typeof result !== 'object') throw confirmationInvalid();
    const declined = result.action !== 'accept' || result.content?.[CONFIRM_INPUT] === false;
    return { id, verdict: declined ? 'declined' : 'accepted' };
  }

  /** The request state for pending action id. Ids and user ids hold no dots. */
  sign(userId: string, id: string, expires: Date): string {
    const payload = `${userId}.${id}.${Math.floor(expires.getTime() / 1000)}`;
    return `${payload}.${this.mac(payload)}`;
  }

  /** The pending action id a state names, if the state is this server's, for userId, and not expired at now. */
  verify(state: string, userId: string, now: Date): string {
    const parts = state.split('.');
    if (parts.length !== 4 || userId === '' || parts[0] !== userId) throw confirmationInvalid();
    const given = Buffer.from(parts[3]!);
    const want = Buffer.from(this.mac(parts.slice(0, 3).join('.')));
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw confirmationInvalid();
    const expires = Number(parts[2]);
    if (!Number.isInteger(expires) || now.getTime() / 1000 > expires) throw confirmationInvalid();
    return parts[1]!;
  }

  /** The hex HMAC-SHA256 of payload. */
  private mac(payload: string): string {
    return createHmac('sha256', this.key).update(payload).digest('hex');
  }
}
