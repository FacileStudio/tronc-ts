import type { Tool, ToolSpec } from './tool';

/** The characters a tool name may hold after its app prefix. */
const TAIL = /^[a-z0-9_]+$/;

/**
 * Refuses a tool without the app prefix, a lowercase name, a title, a
 * description and annotations, a name already taken, a read-only destructive
 * tool, or a writing tool on a server with no write scope.
 */
export function checkTools(tools: Tool[], prefix: string, writeScope: string | undefined): void {
  const seen = new Set<string>();
  for (const { spec } of tools) {
    const problem = problemOf(spec, prefix, seen) ?? writeProblem(spec, writeScope);
    if (problem) throw new Error(`mcp: tool "${spec.name}" ${problem}`);
    seen.add(spec.name);
  }
}

/** What is wrong with spec on its own, if anything. */
function problemOf(spec: ToolSpec, prefix: string, seen: Set<string>): string | undefined {
  const rest = spec.name.startsWith(prefix) ? spec.name.slice(prefix.length) : '';
  if (!TAIL.test(rest)) return `must be named ${prefix}<verb>, in lowercase letters, digits and _`;
  if (seen.has(spec.name)) return 'is registered twice';
  if (!spec.title || !spec.description) return 'needs a title and a description';
  if (!spec.annotations) return 'needs its annotations';
  if (spec.annotations.readOnly && spec.annotations.destructive) return 'cannot be read-only and destructive';
  if (!spec.inputSchema) return 'needs an input schema';
  return undefined;
}

/** The problem with a writing tool on a server that has no write scope. */
function writeProblem(spec: ToolSpec, writeScope: string | undefined): string | undefined {
  return !spec.annotations.readOnly && !writeScope ? 'writes, so the server needs a write scope' : undefined;
}
