import { gone, OUTCOME_RUNNING, type Action, type Pending } from '../mcp';

/** One stored action and its resolution. */
interface Row {
  action: Action;
  resolved: boolean;
  outcome: string;
}

/** An in-memory Pending for tests. JavaScript runs one claim at a time, like the UPDATE of SqlPending. */
export class MemoryPending implements Pending {
  private readonly rows = new Map<string, Row>();

  /** Stores action. */
  async create(action: Action): Promise<void> {
    this.rows.set(action.id, { action, resolved: false, outcome: '' });
  }

  /** Lists userId's open actions, newest first. */
  async open(userId: string): Promise<Action[]> {
    return [...this.rows.values()]
      .filter((row) => isOpen(row, userId))
      .map((row) => row.action)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id));
  }

  /** Marks one open action running. */
  async claim(userId: string, id: string): Promise<Action> {
    const row = this.rows.get(id);
    if (!row || !isOpen(row, userId)) throw gone();
    row.resolved = true;
    row.outcome = OUTCOME_RUNNING;
    return row.action;
  }

  /** Records an outcome. */
  async finish(id: string, outcome: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.outcome = outcome;
  }

  /** Reopens a running action. */
  async release(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (row?.outcome === OUTCOME_RUNNING) Object.assign(row, { resolved: false, outcome: '' });
  }

  /** Closes an open action. */
  async resolve(userId: string, id: string, outcome: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row || row.action.userId !== userId || row.resolved) throw gone();
    Object.assign(row, { resolved: true, outcome });
  }

  /** The recorded outcome of action id, for assertions. */
  outcome(id: string): string {
    return this.rows.get(id)?.outcome ?? '';
  }
}

/** Reports whether row is userId's, unresolved and unexpired. */
function isOpen(row: Row, userId: string): boolean {
  return row.action.userId === userId && !row.resolved && Date.now() < row.action.expiresAt.getTime();
}
