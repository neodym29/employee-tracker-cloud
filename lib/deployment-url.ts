export const DEPLOYMENT_URL_MAX = 2048;

export function normalizeDeploymentUrl(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error('Deployment URL must be a web address');
  const candidate = value.trim();
  if (!candidate) return null;
  if (candidate.length > DEPLOYMENT_URL_MAX || /[\u0000-\u001f\u007f]/.test(candidate)) {
    throw new Error('Deployment URL is invalid');
  }
  let parsed: URL;
  try { parsed = new URL(candidate); }
  catch { throw new Error('Enter a complete HTTPS deployment URL'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname.includes('.')) {
    throw new Error('Enter a public HTTPS deployment URL');
  }
  parsed.hash = '';
  return parsed.toString();
}
