/** Shared uploader/ingest/provider boundary for selected-repository Git text.
 * Git-declared metadata is not proof of employee authorship. Never accept bodies,
 * diffs, emails or arbitrary objects. Omit unsafe text, not partial credentials.
 * Limits are UTF-8 bytes; use no runtime dependencies so CLI and VM share policy.
 */
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export function safeReportText(value: unknown): string {
  if (typeof value !== 'string') return '';
  // Fail closed on a raw patch: filtering only its headers leaks source lines.
  if (/^(?:diff --git |@@ .*@@|--- (?:a\/|\/dev\/null)|\+\+\+ (?:b\/|\/dev\/null))/m.test(value)) return '';
  const lines: string[] = [];
  let bytes = 0;
  for (const line of value.split(/\r?\n/)) {
    // Keep Markdown indentation; validation trims metadata, not report layout.
    const clean = !line.trim() || safeGitWorkText(line, 8000) !== undefined ? line : '';
    const size = utf8Bytes(clean) + (lines.length ? 1 : 0);
    if (bytes + size > 64000) break; // retain complete lines and Unicode characters
    lines.push(clean);
    bytes += size;
  }
  return lines.join('\n').trim();
}

export function safeGitWorkText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(limit) || limit < 0 || value.length > limit || utf8Bytes(value) > limit || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  if (/[a-z][a-z0-9+.-]*:\/\/|(?:^|[\s("'`=\[<])(?:\/|~[^\s/\\]*[\\/]|[a-z]:[\\/]|\\|\.\.[\\/])|\b[^\s<>@]+@[^\s<>@]+|\b(?:authorization|cookie|set-cookie)\s*:|\b(?:bearer\s+|(?:token|secret|password|credential|api[_-]?key)\s*(?:[:=]|\bis\b))|\b(?:sk[-_]|gh[pousr]_|github_pat_|etn_|fad_)[a-z0-9_-]+/i.test(value)) return undefined;
  return value.trim();
}
