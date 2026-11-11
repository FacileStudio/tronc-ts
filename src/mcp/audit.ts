/** Receives audit records. A pino logger fits as is: `info(fields, message)`. */
export interface AuditLogger {
  /** Records one structured line. */
  info(fields: Record<string, unknown>, message: string): void;
}

/** The person a tool call acts for, and the client acting. */
export interface Caller {
  /** The app's id of the person, as the verifier resolved it. */
  userId: string;
  /** The OAuth client the token was issued to. */
  clientId: string;
  /** The agent acting for the person on a delegated token, empty otherwise. */
  actor: string;
  /** The Registre sub of the person. */
  subject: string;
  /** The scopes the token grants. */
  scopes: string[];
}

/** One audited write: the tool, how it ended, who asked through which client, and what it touched. */
export interface AuditEvent {
  tool: string;
  outcome: string;
  caller: Caller;
  target?: string;
}

/** Writes JSON lines to stdout, the default when an app passes no logger. */
export const consoleAudit: AuditLogger = {
  info(fields, message) {
    console.log(JSON.stringify({ level: 'info', msg: message, ...fields }));
  },
};

/** Logs one write. It never logs arguments or content, so a mail body never reaches the logs. */
export function audit(logger: AuditLogger, event: AuditEvent): void {
  logger.info(
    {
      tool: event.tool,
      outcome: event.outcome,
      user_id: event.caller.userId,
      client_id: event.caller.clientId,
      actor: event.caller.actor,
      target: event.target ?? '',
    },
    'mcp write',
  );
}
