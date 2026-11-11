import type { AuthInfo } from '@modelcontextprotocol/server';
import type { Caller } from './audit';

/** The AuthInfo.extra keys callerFrom reads; registreVerifier sets them. */
export const EXTRA_USER_ID = 'user_id';
export const EXTRA_ACTOR = 'actor';
export const EXTRA_SUBJECT = 'subject';

/** Reads the caller from a verified token, or undefined when there is none. */
export function callerFrom(info: AuthInfo | undefined): Caller | undefined {
  const userId = info?.extra?.[EXTRA_USER_ID];
  if (!info || typeof userId !== 'string' || userId === '') return undefined;
  const text = (key: string) => (typeof info.extra?.[key] === 'string' ? (info.extra[key] as string) : '');
  return { userId, clientId: info.clientId, actor: text(EXTRA_ACTOR), subject: text(EXTRA_SUBJECT), scopes: info.scopes };
}
