/** What an idea is based on: a label and Bulle's reference, a fingerprint such as courrier:5/email:812 or a URL. */
export interface Source {
  label: string;
  ref: string;
}

/** One idea card. */
export interface Idea {
  id: string;
  space_id: string;
  app: string;
  kind: string;
  title: string;
  why: string;
  draft: string;
  sources: Source[];
  status: string;
  created_at: string;
  expires_at: string;
}

/** An app's open ideas in one space. */
export interface IdeaList {
  ideas: Idea[];
  generating: boolean;
  last_batch_at: string | null;
}

/** The batch a generate started. */
export interface Batch {
  batch_id: string;
}

/** The background run doing an idea. */
export interface RunStart {
  run_id: string;
  session_id: string;
  idea_id: string;
}

/** One call of a run that changed the person's data. url is empty unless it is an http or https link. */
export interface Output {
  call_id: string;
  tool: string;
  app: string;
  id: string;
  url: string;
  preview: string;
}

/** A call waiting for the person. Answer it with Client.decide. */
export interface Approval {
  call_id: string;
  tool: string;
  args: unknown;
  grantable: boolean;
}

/** Run states, as the app's page shows them. */
export const RUN_STATES = { running: 'running', needsApproval: 'needs_approval', done: 'done', failed: 'failed' } as const;

/** One of RUN_STATES. */
export type RunState = (typeof RUN_STATES)[keyof typeof RUN_STATES];

/** A background run. status is Bulle's own; state is derived from it; continue_url opens the run's chat in Bulle. */
export interface Run {
  id: string;
  session_id: string;
  status: string;
  state: RunState;
  summary: string;
  outputs: Output[];
  pending_approvals: Approval[];
  started_at: string;
  finished_at: string | null;
  continue_url: string;
}

/**
 * One completion an app asks for its person. input is untrusted data the
 * prompt works on; schema, a JSON Schema, makes the answer a validated JSON
 * value instead of text. spaceId names the space the request is for, so a
 * space plan with AI access covers it.
 */
export interface CompleteRequest {
  system?: string;
  prompt: string;
  input?: string;
  schema?: Record<string, unknown>;
  maxTokens?: number;
  spaceId?: string;
}

/** text, or json when the request sent a schema, and the model that wrote it. */
export interface CompleteResponse {
  text?: string;
  json?: unknown;
  model: string;
}

/** One typed question of a decision: a choice between 2 and 64 options. */
export interface Question {
  type: 'choice';
  instructions: unknown;
  criteria?: unknown;
  options: string[];
}

/** One decision a service asks for the Bulle person named by actingFor: a state and up to 8 questions about it. */
export interface DecideRequest {
  actingFor: string;
  state: unknown;
  questions: Record<string, Question>;
}

/** One question's result. */
export interface Answer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

/** Every answer keyed by its question's name, the model that served them and what the call billed. */
export interface DecideResponse {
  answers: Record<string, Answer>;
  model: string;
  usage: Record<string, unknown>;
}
