import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const installer = readFileSync(new URL('../app/api/installer/route.ts', import.meta.url), 'utf8');

assert.match(installer, /const EVENT_BATCH_SIZE = 8;/, 'generated browser extensions should drain telemetry in small bounded batches');
assert.match(installer, /const EVENT_SPACING_MS = 250;/, 'generated browser extensions should space requests instead of bursting');
assert.match(installer, /const TAB_DEBOUNCE_MS = 3000;/, 'tab event storms should be debounced');
assert.match(installer, /const TAB_MIN_INTERVAL_MS = 15000;/, 'full tab scans should have a minimum interval');
assert.match(installer, /const INJECTION_BATCH_SIZE = 3;/, 'open-tab content script injection should use small batches');
assert.match(installer, /scheduleTabCollection/, 'tab listeners should schedule, not immediately perform, full scans');
assert.match(installer, /enqueuePost/, 'click and typing telemetry should enter the paced queue');
assert.match(installer, /await sleep\(INJECTION_SPACING_MS\)/, 'content-script injection batches should yield between tabs');
assert.doesNotMatch(installer, /Promise\.allSettled\(\(tabs\|\|\[\]\)/, 'extension startup must not inject into every open tab concurrently');
assert.doesNotMatch(installer, /setInterval\(collectTabs,\s*10000\)/, 'extension must not run a full tab scan every ten seconds');
assert.doesNotMatch(installer, /onUpdated\.addListener\(collectTabs\)/, 'tab update storms must not directly trigger full tab scans');

console.log('browser extension telemetry is paced and bounded');
