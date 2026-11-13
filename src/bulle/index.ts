/**
 * The client a suite app uses to reach Bulle as the signed-in person: the
 * Ideas API, completions and decisions. It is the TypeScript counterpart of
 * Go github.com/FacileStudio/tronc/bulle and keeps its paths, its escaping
 * and its error mapping. Redirects are refused, and an upgrade page that is
 * not a same-origin path or an https URL is dropped.
 */
export * from './client';
export * from './errors';
export { encodeQuery, pathEscape } from './escape';
export * from './types';
