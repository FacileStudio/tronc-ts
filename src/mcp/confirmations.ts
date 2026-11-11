import { randomBytes } from 'node:crypto';
import type { InputRequiredResult } from '@modelcontextprotocol/server';
import { audit, consoleAudit, type AuditLogger, type Caller } from './audit';
import { canElicit, confirmationInvalid, Signer } from './confirm';
import { failed, internal } from './errors';
import { OUTCOME_DECLINED, OUTCOME_DISMISSED, OUTCOME_DONE, OUTCOME_STALE, type Action, type Pending } from './pending';
import type { ToolRequest } from './tool';

/** Statuses of an Outcome. A tool puts the status in its result, next to confirm_url when pending. */
export const STATUS_PENDING = 'pending_confirmation';
export const STATUS_DECLINED = 'declined';
export const STATUS_DONE = 'done';

/** The states of a pending action on a confirm page. */
export const STATE_READY = 'ready';
export const STATE_CHANGED = 'changed';
export const STATE_MISSING = 'missing';

/** Default lifetimes of a pending action and of the signed question. */
export const DEFAULT_PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_ASK_TTL_MS = 15 * 60 * 1000;

/** The refusal for a target that changed after the person was asked. The action closes. */
export const ERR_CHANGED =
  'this changed after the user was asked, so nothing happened. Call the tool again to ask about the current version';

/** Runs one kind of sensitive action. */
export interface Kind {
  /** The tool that asks for this kind, for the audit. */
  tool: string;
  /** A digest of the target as it is now. A target that is gone throws notFound. */
  fingerprint(action: Action): Promise<string>;
  /** Performs the action. */
  run(action: Action): Promise<void>;
}

/** Describes the confirmations of one app. */
export interface ConfirmConfig {
  /** Keeps pending actions; SqlPending in production. */
  store: Pending;
  /** Signs the question state. It must stay secret and stable across restarts and replicas, 32 bytes or more. */
  key: Uint8Array | string;
  /** The app page where the person confirms; the action id goes in the `action` query parameter. */
  confirmUrl: string;
  /** Maps each kind to how it runs. */
  kinds: Record<string, Kind>;
  /** Receives one record per request, answer and run. */
  audit?: AuditLogger;
  pendingTtlMs?: number;
  askTtlMs?: number;
}

/** Where a sensitive action stands after a call. */
export interface Outcome {
  status: string;
  action: Partial<Action>;
  /** The link to give the person when status is STATUS_PENDING. */
  confirmUrl?: string;
}

/**
 * Asks a person before a sensitive action runs: through MRTR input_required
 * when the client can elicit, otherwise through a pending action and a
 * confirm link the client hands over. Nothing runs without the person's answer.
 */
export class Confirmations {
  private readonly signer: Signer;
  private readonly log: AuditLogger;

  /** Checks cfg; it throws at boot on a missing store, short key, relative link or incomplete kind. */
  constructor(private readonly cfg: ConfirmConfig) {
    const key = typeof cfg.key === 'string' ? new TextEncoder().encode(cfg.key) : cfg.key;
    if (!cfg.store || key.length < 32 || Object.keys(cfg.kinds).length === 0) {
      throw new Error('mcp: confirmations need a store, a key of 32 bytes or more and at least one kind');
    }
    if (!URL.canParse(cfg.confirmUrl)) throw new Error('mcp: the confirm URL must be absolute');
    for (const [name, kind] of Object.entries(cfg.kinds)) {
      if (!kind.tool || !kind.fingerprint || !kind.run) throw new Error(`mcp: kind ${name} needs a tool, a fingerprint and a run`);
    }
    this.signer = new Signer(key, cfg.askTtlMs ?? DEFAULT_ASK_TTL_MS);
    this.log = cfg.audit ?? consoleAudit;
  }

  /**
   * Opens a pending action of kind on target and asks question. When the
   * client can elicit, result is the input_required result to return as is.
   * Otherwise the outcome holds STATUS_PENDING and the confirm link. Nothing ran.
   */
  async request(req: ToolRequest, kind: string, target: string, question: string): Promise<{ result?: InputRequiredResult; outcome: Outcome }> {
    const runner = this.kind(kind);
    const who = req.caller;
    const draft = { userId: who.userId, kind, target, summary: question, clientId: who.clientId };
    const action = await this.create({ ...draft, digest: await runner.fingerprint(draft as Action) });
    this.audit(runner.tool, 'requested', who, target);
    if (canElicit(req.ctx)) {
      return { result: this.signer.ask(who.userId, action.id, question), outcome: { status: STATUS_PENDING, action } };
    }
    return { outcome: { status: STATUS_PENDING, action, confirmUrl: this.link(action.id) } };
  }

  /** Handles the retry that carries the answer to a question about kind: a decline closes, an accept runs once. */
  async resume(req: ToolRequest, kind: string): Promise<Outcome> {
    const who = req.caller;
    const { id, verdict } = this.signer.answer(req.ctx, who.userId);
    if (verdict === 'declined') {
      await this.cfg.store.resolve(who.userId, id, OUTCOME_DECLINED);
      this.audit(this.kind(kind).tool, OUTCOME_DECLINED, who, '');
      return { status: STATUS_DECLINED, action: { id, kind } };
    }
    return { status: STATUS_DONE, action: await this.run(who, id, kind) };
  }

  /** Runs one of who's actions from the confirm page. The page must refuse a delegated token first. */
  async confirm(who: Caller, id: string): Promise<Outcome> {
    return { status: STATUS_DONE, action: await this.run(who, id, '') };
  }

  /** Closes one of who's actions without running it. */
  async dismiss(who: Caller, id: string): Promise<void> {
    await this.cfg.store.resolve(who.userId, id, OUTCOME_DISMISSED);
    this.audit('pending', OUTCOME_DISMISSED, who, id);
  }

  /** Lists the person's waiting actions, newest first. */
  open(userId: string): Promise<Action[]> {
    return this.cfg.store.open(userId);
  }

  /** Tells a confirm page whether an action still matches what the person was asked about. */
  async state(action: Action): Promise<string> {
    const runner = this.cfg.kinds[action.kind];
    if (!runner) return STATE_MISSING;
    try {
      return (await runner.fingerprint(action)) === action.digest ? STATE_READY : STATE_CHANGED;
    } catch {
      return STATE_MISSING;
    }
  }

  /** The confirm page URL for action id. */
  link(id: string): string {
    const url = new URL(this.cfg.confirmUrl);
    url.searchParams.set('action', id);
    return url.toString();
  }

  /** Claims one of who's actions, checks it still matches, runs it and records how it ended. */
  private async run(who: Caller, id: string, kind: string): Promise<Action> {
    const action = await this.cfg.store.claim(who.userId, id);
    const runner = this.cfg.kinds[action.kind];
    if (!runner || (kind !== '' && action.kind !== kind)) {
      await this.cfg.store.release(id);
      throw confirmationInvalid();
    }
    const outcome = await this.execute(runner, action);
    this.audit(runner.tool, outcome.audit, { ...who, clientId: action.clientId }, action.target);
    if (outcome.error) throw outcome.error;
    return action;
  }

  /** Runs action if its target still has the digest it was asked with, and closes or reopens it. */
  private async execute(runner: Kind, action: Action): Promise<{ audit: string; error?: unknown }> {
    try {
      if ((await runner.fingerprint(action)) !== action.digest) {
        await this.cfg.store.finish(action.id, OUTCOME_STALE);
        return { audit: OUTCOME_STALE, error: failed(ERR_CHANGED) };
      }
      await runner.run(action);
    } catch (error) {
      await this.cfg.store.release(action.id);
      return { audit: 'failed', error };
    }
    await this.cfg.store.finish(action.id, OUTCOME_DONE);
    return { audit: OUTCOME_DONE };
  }

  /** Stores draft under a fresh random id. */
  private async create(draft: Omit<Action, 'id' | 'createdAt' | 'expiresAt'>): Promise<Action> {
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + (this.cfg.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS));
    const action = { ...draft, id: randomBytes(18).toString('base64url'), createdAt, expiresAt };
    await this.cfg.store.create(action);
    return action;
  }

  /** The Kind registered for name. */
  private kind(name: string): Kind {
    const runner = this.cfg.kinds[name];
    if (!runner) throw internal(`mcp: unknown confirmation kind ${name}`);
    return runner;
  }

  /** Records one confirmation event. */
  private audit(tool: string, outcome: string, caller: Caller, target: string): void {
    audit(this.log, { tool, outcome, caller, target });
  }
}
