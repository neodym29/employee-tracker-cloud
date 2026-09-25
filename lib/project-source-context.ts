/** A public README can describe a project's purpose; Git commit subjects and
 * file names generally cannot. Never follow a user-supplied URL or send app
 * credentials to GitHub. This source is only used for purpose questions. */
export type PublicReadme = { source: 'public GitHub README'; repository: string; text: string };

const MAX_RESPONSE_BYTES = 96 * 1024;
const MAX_README_BYTES = 24 * 1024;
const MAX_EXCERPT_CHARS = 12_000;
const cache = new Map<string, { expires: number; value: PublicReadme | null }>();

export function githubRepositoryFromRemote(remote: unknown): { owner: string; repo: string } | null {
  if (typeof remote !== 'string') return null;
  let url: URL;
  try { url = new URL(remote); } catch { return null; }
  if (!['https:', 'ssh:'].includes(url.protocol) || url.hostname !== 'github.com' || url.port || url.password || url.search || url.hash) return null;
  if (url.protocol === 'https:' && url.username || url.protocol === 'ssh:' && url.username !== 'git') return null;
  const match = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\.git$/.exec(url.pathname);
  if (!match || match[1].length > 39 || match[2].length > 100 || match[2] === '.' || match[2] === '..') return null;
  return { owner: match[1], repo: match[2] };
}

async function boundedText(response: Response): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel('README response too large').catch(() => {}); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), bytes).toString('utf8');
}

function readableExcerpt(markdown: string): string {
  let inCode = false;
  const lines: string[] = [];
  for (const original of markdown.split(/\r?\n/)) {
    const line = original.trim();
    if (/^(```|~~~)/.test(line)) { inCode = !inCode; continue; }
    if (inCode || !line || /^(!\[|\[!\[|<|\||\[.+\]:)/.test(line)) continue;
    const plain = line.replace(/^#{1,6}\s*/, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').trim();
    if (plain && !/[\u0000-\u001f\u007f]/.test(plain)) lines.push(plain);
    if (lines.join('\n').length >= MAX_EXCERPT_CHARS) break;
  }
  return lines.join('\n').slice(0, MAX_EXCERPT_CHARS);
}

export async function loadPublicGitHubReadme(remote: unknown, fetcher: typeof fetch = fetch): Promise<PublicReadme | null> {
  const repository = githubRepositoryFromRemote(remote);
  if (!repository) return null;
  const key = `${repository.owner}/${repository.repo}`.toLowerCase();
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  let value: PublicReadme | null = null;
  try {
    const response = await fetcher(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/readme`, {
      method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'employee-trace-project-context', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (response.ok) {
      const body = await boundedText(response);
      if (body) {
        const parsed: unknown = JSON.parse(body);
        const file = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
        if (file.encoding === 'base64' && typeof file.content === 'string' && Number(file.size) <= MAX_README_BYTES && /^[A-Za-z0-9+/=\s]+$/.test(file.content)) {
          const markdown = Buffer.from(file.content, 'base64').toString('utf8');
          if (Buffer.byteLength(markdown, 'utf8') <= MAX_README_BYTES) {
            const text = readableExcerpt(markdown);
            if (text) value = { source: 'public GitHub README', repository: key, text };
          }
        }
      }
    }
  } catch { /* Private, unavailable, oversized, or timed out: do not guess. */ }
  finally { clearTimeout(timer); }
  if (cache.size >= 100) cache.clear();
  cache.set(key, { value, expires: Date.now() + (value ? 5 * 60_000 : 60_000) });
  return value;
}
