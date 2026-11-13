import { parseUrl } from './url';

/**
 * Reports whether raw is a same-origin path or an https URL with a host and
 * no credentials, like Go errors.SafeUpgradeURL. A client renders the upgrade
 * page as a link, so a javascript:, http: or protocol-relative URL is unsafe.
 */
export function safeUpgradeUrl(raw: string): boolean {
  if (raw === '' || /[\p{Cc} \\]/u.test(raw)) return false;
  if (raw.startsWith('/')) return !raw.startsWith('//');
  const parsed = parseUrl(raw);
  return parsed !== undefined && parsed.scheme === 'https' && parsed.host !== '' && !parsed.user;
}
