import { afterAll } from 'bun:test';
import { MemoryPending, newIssuer, run } from '../mcptest';
import {
  Confirmations, newServer, newTool, notFound, registreVerifier, retrying, STATUS_DECLINED, STATUS_DONE,
  STATUS_PENDING, type Action, type ToolRequest,
} from '.';

const issuer = await newIssuer();
const notes = new Map<string, { title: string }>([['n1', { title: 'first' }]]);
const deletions = new Map<string, number>();
const resourceHolder = { url: '' };

const confirmations = new Confirmations({
  store: new MemoryPending(),
  key: 'a-test-key-that-is-at-least-32-bytes-long',
  confirmUrl: 'https://notes.example/pending',
  audit: { info: () => {} },
  kinds: {
    delete_note: {
      tool: 'notes_note_delete',
      fingerprint: async (a: Action) => {
        const note = notes.get(a.target);
        if (!note) throw notFound('note not found');
        return note.title;
      },
      run: async (a: Action) => {
        notes.delete(a.target);
        deletions.set(a.target, (deletions.get(a.target) ?? 0) + 1);
      },
    },
  },
});

const listNotes = newTool({
  name: 'notes_list',
  title: 'List notes',
  description: 'Lists the notes of the person, newest first.',
  annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
  inputSchema: { type: 'object', properties: {} },
}, async () => ({ notes: [...notes].map(([id, n]) => ({ id, title: n.title })) }));

const deleteNote = newTool<{ id: string }>({
  name: 'notes_note_delete',
  title: 'Delete a note',
  description: 'Deletes one note after the person confirms. Get ids from notes_list.',
  annotations: { readOnly: false, destructive: true, idempotent: false, openWorld: false },
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
}, async ({ id }, req: ToolRequest) => {
  if (retrying(req.ctx)) {
    const outcome = await confirmations.resume(req, 'delete_note');
    return { status: outcome.status === STATUS_DONE ? STATUS_DONE : STATUS_DECLINED };
  }
  const { result, outcome } = await confirmations.request(req, 'delete_note', id, `Delete note ${id}?`);
  return result ?? { status: STATUS_PENDING, confirm_url: outcome.confirmUrl };
});

const http = Bun.serve({ port: 0, fetch: (request) => server.fetch(request) });
resourceHolder.url = `http://127.0.0.1:${http.port}/mcp`;
const server = newServer({
  name: 'notes',
  title: 'Notes',
  version: '0.0.0',
  resource: resourceHolder.url,
  issuer: issuer.url,
  verifier: await registreVerifier({ issuer: issuer.url, resource: resourceHolder.url, scopePrefix: 'notes' }),
  tools: [listNotes, deleteNote],
  audit: { info: () => {} },
});

afterAll(() => {
  http.stop(true);
  issuer.close();
});

let next = 0;
run({
  url: resourceHolder.url,
  token: (...scopes) => issuer.token(resourceHolder.url, 'person', ...(scopes.length ? scopes : ['notes.read', 'notes.write'])),
  confirm: [{
    tool: 'notes_note_delete',
    setup: async () => {
      const id = `t${next++}`;
      notes.set(id, { title: id });
      return { args: { id }, runs: () => deletions.get(id) ?? 0 };
    },
  }],
});
