export const GIT_REMOTE_MAX = 2048;
export const GIT_REPOSITORY_KEY_MAX = 1024;

export type ParsedGitRemote = { remoteUrl: string; repositoryKey: string };

function invalid(): never { throw new Error('A valid credential-free Git remote is required'); }
function unsafe(value: string) {
  return /[\u0000-\u001f\u007f]/.test(value)
    || /(?:^|[/\\])\.\.(?:[/\\]|$)/.test(value)
    || /%(?:2e|2f|5c)/i.test(value)
    || /(?:password|passwd|token|secret|credential|api[_-]?key|private[_-]?key|gh[pousr]_|sk[-_])/i.test(value);
}
function validHost(value: string): boolean {
  const host = value.toLowerCase();
  if (host.startsWith('[') || host.endsWith(']')) {
    if (!(host.startsWith('[') && host.endsWith(']'))) return false;
    try {
      const parsed = new URL(`http://${host}/`);
      return parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']');
    } catch { return false; }
  }
  if (/^[0-9.]+$/.test(host)) {
    const octets = host.split('.');
    return octets.length === 4 && octets.every((octet) => /^(?:0|[1-9][0-9]{0,2})$/.test(octet) && Number(octet) <= 255);
  }
  if (host.length > 253) return false;
  const labels = host.split('.');
  return labels.length >= 2 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
function finish(hostname: string, port: string, pathValue: string, transport: 'https' | 'ssh'): ParsedGitRemote {
  const host = hostname.toLowerCase();
  if (!validHost(host) || host === 'localhost' || host.endsWith('.local') || /^127\.|^0\.|^\[?::1\]?$/.test(host)) invalid();
  const hadGitSuffix = /\.git\/?$/i.test(pathValue);
  let path = pathValue.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!path || path.length > GIT_REPOSITORY_KEY_MAX || path.split('/').length < 2 || path.split('/').some((part) => !part || part === '.' || part === '..')) invalid();
  if (!/^[A-Za-z0-9._~+-]+(?:\/[A-Za-z0-9._~+-]+)+$/.test(path)) invalid();
  const parts = path.split('/');
  if ((host === 'github.com' || host === 'bitbucket.org') && parts.length !== 2) invalid();
  if (host === 'gitlab.com' && (path.includes('/-/') || parts.slice(2).some((part) => ['issues', 'pull', 'pulls', 'tree', 'blob', 'commit', 'commits', 'merge_requests'].includes(part.toLowerCase())))) invalid();
  if (transport === 'https' && !['github.com', 'bitbucket.org', 'gitlab.com'].includes(host) && !hadGitSuffix) invalid();
  const normalizedPort = (transport === 'https' && port === '443') || (transport === 'ssh' && port === '22') ? '' : port;
  const authority = `${host}${normalizedPort ? `:${normalizedPort}` : ''}`;
  const repositoryKey = `${authority}/${path}`;
  if (repositoryKey.length > GIT_REPOSITORY_KEY_MAX) invalid();
  return { repositoryKey, remoteUrl: transport === 'https' ? `https://${authority}/${path}.git` : `ssh://git@${authority}/${path}.git` };
}

export function parseGitRemote(value: unknown): ParsedGitRemote {
  if (typeof value !== 'string' || !value || value.length > GIT_REMOTE_MAX || value !== value.trim() || unsafe(value)) invalid();
  // Bracketed IPv6 is intentionally URL-only: SCP's colon delimiter is
  // ambiguous there, so callers must use ssh://git@[...]/owner/repository.
  const scp = /^git@([a-z0-9.-]+):([^?#]+)$/i.exec(value);
  if (scp) return finish(scp[1], '', scp[2], 'ssh');
  let parsed: URL;
  try { parsed = new URL(value); } catch { return invalid(); }
  if (parsed.search || parsed.hash) invalid();
  if (parsed.protocol === 'https:') {
    if (parsed.username || parsed.password) invalid();
    return finish(parsed.hostname, parsed.port, parsed.pathname, 'https');
  }
  if (parsed.protocol === 'ssh:') {
    if (parsed.password || parsed.username !== 'git') invalid();
    return finish(parsed.hostname, parsed.port, parsed.pathname, 'ssh');
  }
  return invalid();
}

export function canonicalRepositoryKey(value: unknown): string { return parseGitRemote(value).repositoryKey; }
