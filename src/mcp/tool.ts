import {
  fromJsonSchema,
  isInputRequiredResult,
  requireScopes,
  type CallToolResult,
  type InputRequiredResult,
  type JsonSchemaType,
  type McpServer,
  type ServerContext,
  type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { audit, type AuditLogger, type Caller } from './audit';
import { callerFrom } from './caller';
import { ERR_UNAVAILABLE, failure, ToolFailure } from './failure';

/** The refusal for a call that reached a tool without a verified token. */
export const ERR_NO_TOKEN = 'this request carries no valid access token. Reconnect the app';

/**
 * A tool's hints for the client's permission UI. Every tool declares all four,
 * because clients treat a missing destructive or open-world hint as true. They
 * are UX, never the gate: the scopes and Confirmations are.
 */
export interface Annotations {
  /** Changes nothing. Every other tool needs the write scope. */
  readOnly: boolean;
  /** May delete or overwrite. A read-only tool is never destructive. */
  destructive: boolean;
  /** No further effect when called again with the same arguments. */
  idempotent: boolean;
  /** Reads or reaches content from outside the app, such as web pages. */
  openWorld: boolean;
}

/** A JSON Schema object or a Standard Schema with JSON Schema output, such as a zod 4 object. */
export type Schema = JsonSchemaType | StandardSchemaWithJSON;

/** Describes one tool. */
export interface ToolSpec {
  /** `<app>_<verb>` or `<app>_<resource>_<verb>`, lowercase. */
  name: string;
  /** The human name shown in clients. */
  title: string;
  /** Tells the model when to call the tool and what it returns. */
  description: string;
  /** Required, so each tool states its hints on purpose. */
  annotations: Annotations;
  /** The arguments, an object schema. */
  inputSchema: Schema;
  /** The structured result, an object schema, when the tool declares one. */
  outputSchema?: Schema;
}

/** What a handler gets besides its arguments: who calls, and the SDK context. */
export interface ToolRequest {
  caller: Caller;
  ctx: ServerContext;
}

/** A handler returns its structured result, or the input_required result of a confirmation. */
export type ToolHandler<In, Out> = (input: In, req: ToolRequest) => Promise<Out | InputRequiredResult>;

/** What a registered handler checks and reports around each call. */
export interface Guard {
  writeScope: string;
  audit: AuditLogger;
  onError: (err: unknown, tool: string) => void;
}

/** A curated tool ready for newServer. */
export interface Tool {
  readonly spec: ToolSpec;
  readonly register: (server: McpServer, guard: Guard) => void;
}

/**
 * Builds a tool from spec and a handler. A thrown failure() or TroncError
 * becomes an isError result a model can act on; anything else becomes
 * ERR_UNAVAILABLE and goes to Options.onError.
 */
export function newTool<In = Record<string, unknown>, Out extends object = Record<string, unknown>>(
  spec: ToolSpec,
  handler: ToolHandler<In, Out>,
): Tool {
  return {
    spec,
    register(server, guard) {
      const run = (input: unknown, ctx: ServerContext) => guarded(spec, guard, handler, input as In, ctx);
      server.registerTool(spec.name, registration(spec, guard), run as never);
    },
  };
}

/** The SDK registration of spec: schemas, all four hints, and the write-scope challenge of a writing tool. */
function registration(spec: ToolSpec, guard: Guard) {
  const a = spec.annotations;
  return {
    title: spec.title,
    description: spec.description,
    inputSchema: standard(spec.inputSchema),
    ...(spec.outputSchema && { outputSchema: standard(spec.outputSchema) }),
    annotations: {
      title: spec.title, readOnlyHint: a.readOnly, destructiveHint: a.destructive,
      idempotentHint: a.idempotent, openWorldHint: a.openWorld,
    },
    ...(!a.readOnly && { scopeChallenge: requireScopes(guard.writeScope) }),
  };
}

/** Runs handler for a verified caller, with the write-scope check and one audit record per write. */
async function guarded<In, Out extends object>(
  spec: ToolSpec, guard: Guard, handler: ToolHandler<In, Out>, input: In, ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  let result: CallToolResult | InputRequiredResult;
  const caller = callerFrom(ctx.http?.authInfo);
  try {
    if (!caller) throw new ToolFailure(ERR_NO_TOKEN);
    if (!spec.annotations.readOnly && !caller.scopes.includes(guard.writeScope)) {
      throw new ToolFailure(`this tool needs the ${guard.writeScope} scope. Reconnect the app and grant write access`);
    }
    result = reply(await handler(input, { caller, ctx }));
  } catch (err) {
    const refusal = failure(err);
    if (refusal.message === ERR_UNAVAILABLE) guard.onError(err, spec.name);
    result = { isError: true, content: [{ type: 'text', text: refusal.message }] };
  }
  if (caller && !spec.annotations.readOnly) audit(guard.audit, { tool: spec.name, outcome: outcomeOf(result), caller });
  return result;
}

/** Wraps a handler's value as a tool result, passing input_required results through. */
function reply(out: object): CallToolResult | InputRequiredResult {
  if (isInputRequiredResult(out)) return out;
  return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out as Record<string, unknown> };
}

/** The audit outcome of a tool result. */
function outcomeOf(result: CallToolResult | InputRequiredResult): string {
  if (isInputRequiredResult(result)) return 'input_required';
  return result.isError ? 'error' : 'ok';
}

/** Turns a JSON Schema object into the Standard Schema the SDK registers. */
function standard(schema: Schema): StandardSchemaWithJSON {
  return '~standard' in schema ? (schema as StandardSchemaWithJSON) : fromJsonSchema(schema as JsonSchemaType);
}
