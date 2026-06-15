import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const installer = readFileSync(new URL('../app/api/installer/route.ts', import.meta.url), 'utf8');

for (const expected of [
  'function typedTextSample(el, sensitive)',
  "typed_sample_redacted: typedTextSample(el, sensitive)",
  "if (sensitive) return '[sensitive field redacted]'",
  'return value.slice(0, 500)',
]) {
  assert.match(installer, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `installer should upload exact typed text for non-sensitive browser fields: ${expected}`);
}

assert.match(installer, /type === 'password'/, 'password fields must remain sensitive');
assert.match(installer, /one-time-code/, 'OTP fields must remain sensitive');
assert.match(installer, /api\[_ -\]\?key/, 'API key fields must remain sensitive');
assert.doesNotMatch(installer, /\[redacted browser text: ' \+ textLength/, 'non-sensitive browser text must not be blanket redacted');
