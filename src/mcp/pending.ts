import { internal, notFound } from './errors';

/** Outcomes a pending action is resolved with. */
export const OUTCOME_RUNNING = 'running';
export const OUTCOME_DONE = 'done';
export const OUTCOME_DECLINED = 'declined';
export const OUTCOME_DISMISSED = 'dismissed';
export const OUTCOME_STALE = 'stale';

/** The refusal for an action that ran, was dismissed, expired or was never this person's. */
export const ERR_GONE = 'this action was already confirmed, dismissed or expired';

/** Builds the ERR_GONE error, a not_found. */
export const gone = () => notFound(ERR_GONE);

/** One sensitive action waiting for a person. */
export interface Action {
  /** A random token; it appears in the confirm link. */
  id: string;
  /** The person who must confirm. */
  userId: string;
  /** Names the action, such as "delete_lead"; it picks the Kind that runs it. */
  kind: string;
  /** The app's reference to what the action touches. */
  target: string;
  /** Fingerprints the target as it was when the person was asked. Never shown. */
  digest: string;
  /** The question the person was asked, for the confirm page. */
  summary: string;
  /** The OAuth client that asked. */
  clientId: string;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Stores actions waiting for a person. claim must be atomic: of two claims of
 * one open action, exactly one succeeds. That makes every confirmation single
 * use, whether it comes from the client or from the confirm page.
 */
export interface Pending {
  /** Stores a new action; id, createdAt and expiresAt are set. */
  create(action: Action): Promise<void>;
  /** Lists the person's unresolved, unexpired actions, newest first. */
  open(userId: string): Promise<Action[]>;
  /** Marks one of the person's open actions as running and returns it, or throws gone(). */
  claim(userId: string, id: string): Promise<Action>;
  /** Records the outcome of a claimed action. */
  finish(id: string, outcome: string): Promise<void>;
  /** Reopens a claimed action whose run failed. */
  release(id: string): Promise<void>;
  /** Closes one of the person's open actions without running it, or throws gone(). */
  resolve(userId: string, id: string, outcome: string): Promise<void>;
  /** Deletes every action of the people, resolved or not, for an account erasure. */
  erase(...userIds: string[]): Promise<void>;
}

/** The table SqlPending uses, the same as Go mcp.PendingSchema. Idempotent and additive. */
export const PENDING_SCHEMA = `
CREATE TABLE IF NOT EXISTS mcp_actions (
	id          text        PRIMARY KEY,
	user_id     text        NOT NULL,
	kind        text        NOT NULL,
	target      text        NOT NULL,
	digest      text        NOT NULL,
	summary     text        NOT NULL DEFAULT '',
	client_id   text        NOT NULL DEFAULT '',
	created_at  timestamptz NOT NULL DEFAULT now(),
	expires_at  timestamptz NOT NULL,
	resolved_at timestamptz,
	outcome     text        NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS mcp_actions_open_idx
	ON mcp_actions (user_id, created_at DESC) WHERE resolved_at IS NULL;
`;

/**
 * Runs one parameterised statement ($1, $2, ...) and returns its rows. Prisma's
 * `(sql, params) => prisma.$queryRawUnsafe(sql, ...params)` and Bun's
 * `(sql, params) => db.unsafe(sql, params)` both fit.
 */
export type Query = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

/** The column list every read selects. */
const COLUMNS = 'id, user_id, kind, target, digest, summary, client_id, created_at, expires_at';

/** Pending on the mcp_actions table of PENDING_SCHEMA, over any Postgres client. */
export class SqlPending implements Pending {
  /** Wraps query, which must reach a database where PENDING_SCHEMA ran. */
  constructor(private readonly query: Query) {}

  /** Inserts action. */
  async create(a: Action): Promise<void> {
    await this.run(`INSERT INTO mcp_actions (${COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [
      a.id, a.userId, a.kind, a.target, a.digest, a.summary, a.clientId, a.createdAt, a.expiresAt,
    ]);
  }

  /** Lists userId's open actions, newest first. */
  async open(userId: string): Promise<Action[]> {
    const rows = await this.run(`SELECT ${COLUMNS} FROM mcp_actions
      WHERE user_id = $1 AND resolved_at IS NULL AND expires_at > now() ORDER BY created_at DESC, id`, [userId]);
    return rows.map(toAction);
  }

  /** Marks one open action running in a single UPDATE, which is what makes it single use. */
  async claim(userId: string, id: string): Promise<Action> {
    const rows = await this.run(`UPDATE mcp_actions SET resolved_at = now(), outcome = $3
      WHERE id = $1 AND user_id = $2 AND resolved_at IS NULL AND expires_at > now() RETURNING ${COLUMNS}`,
    [id, userId, OUTCOME_RUNNING]);
    if (rows.length === 0) throw gone();
    return toAction(rows[0]!);
  }

  /** Records the outcome of a claimed action. */
  async finish(id: string, outcome: string): Promise<void> {
    await this.run('UPDATE mcp_actions SET outcome = $2 WHERE id = $1 RETURNING id', [id, outcome]);
  }

  /** Reopens a claimed action that is still running. */
  async release(id: string): Promise<void> {
    await this.run(`UPDATE mcp_actions SET resolved_at = NULL, outcome = ''
      WHERE id = $1 AND outcome = $2 RETURNING id`, [id, OUTCOME_RUNNING]);
  }

  /** Closes one of userId's open actions. */
  async resolve(userId: string, id: string, outcome: string): Promise<void> {
    const rows = await this.run(`UPDATE mcp_actions SET resolved_at = now(), outcome = $3
      WHERE id = $1 AND user_id = $2 AND resolved_at IS NULL RETURNING id`, [id, userId, outcome]);
    if (rows.length === 0) throw gone();
  }

  /** Deletes every action of userIds. */
  erase(...userIds: string[]): Promise<void> {
    return erasePending(this.query, ...userIds);
  }

  /** Runs a statement and hides driver errors behind an internal error. */
  private async run(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    try {
      return await this.query(sql, params);
    } catch (cause) {
      throw internal('failed to reach the pending actions', cause);
    }
  }
}

/**
 * Deletes every action of userIds through query, so an account erasure can run
 * it inside its own transaction. One statement per person keeps it free of
 * driver-specific array types.
 */
export async function erasePending(query: Query, ...userIds: string[]): Promise<void> {
  for (const userId of userIds) {
    try {
      await query('DELETE FROM mcp_actions WHERE user_id = $1 RETURNING id', [userId]);
    } catch (cause) {
      throw internal('failed to erase pending actions', cause);
    }
  }
}

/** Reads one row of COLUMNS. */
function toAction(row: Record<string, unknown>): Action {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    kind: String(row.kind),
    target: String(row.target),
    digest: String(row.digest),
    summary: String(row.summary),
    clientId: String(row.client_id),
    createdAt: new Date(row.created_at as string | Date),
    expiresAt: new Date(row.expires_at as string | Date),
  };
}
