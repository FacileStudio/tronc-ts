import { ToolFailure } from './failure';
import { decodeCursor, encodeCursor, ERR_CURSOR } from './page';

/** The position of an offset cursor made by cursorAt: 0 when cursor is empty; a malformed or negative one throws ERR_CURSOR. */
export function offsetOf(cursor: string | undefined): number {
  const offset = decodeCursor<unknown>(cursor) ?? 0;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new ToolFailure(ERR_CURSOR);
  return offset as number;
}

/** The cursor of the page starting at offset in a list of total items, empty when offset is past the end. */
export function cursorAt(offset: number, total: number): string {
  return offset >= total ? '' : encodeCursor(offset);
}

/** The page of at most size items, at least one, at cursor's offset, and the cursor of the next page, empty on the last one. Go mcp.Page. */
export function page<T>(items: T[], cursor: string | undefined, size: number): { items: T[]; next: string } {
  const start = Math.min(offsetOf(cursor), items.length);
  const end = Math.min(start + Math.max(size, 1), items.length);
  return { items: items.slice(start, end), next: cursorAt(end, items.length) };
}
