import 'server-only';

/**
 * Rollback alias retained for callers compiled against the old adapter. Embedded
 * TraceMini has no remote origin, credential, or HTTP transport.
 */
export class TraceMiniUpstreamError extends Error {
  constructor(message = 'Embedded TraceMini transport is local-only', public transient = false, public code: TraceMiniErrorCode = 'unavailable') { super(message); }
}
export type TraceMiniErrorCode = 'unavailable';
export type TraceMiniEndpoint = 'bootstrap' | 'dashboard' | 'settings' | 'agents' | 'reports';

export function validateTraceMiniBaseUrl(_value: unknown): never {
  throw new TraceMiniUpstreamError('Embedded TraceMini does not accept a base URL');
}

/** Compatibility alias: callers must use the embedded database projection. */
export async function traceMiniGet(_baseUrl: string, _credential: string, _endpoint: TraceMiniEndpoint): Promise<never> {
  throw new TraceMiniUpstreamError('Embedded TraceMini does not make upstream requests');
}
