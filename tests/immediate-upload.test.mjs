import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cloud = readFileSync(new URL('../agent/src/employee_tracker/cloud.py', import.meta.url), 'utf8');
const collector = readFileSync(new URL('../agent/src/employee_tracker/collector.py', import.meta.url), 'utf8');
const config = readFileSync(new URL('../agent/src/employee_tracker/config.py', import.meta.url), 'utf8');
const screenshots = readFileSync(new URL('../agent/src/employee_tracker/screenshots.py', import.meta.url), 'utf8');
const installer = readFileSync(new URL('../app/api/installer/route.ts', import.meta.url), 'utf8');

assert.match(cloud, /upload_interval\s*=\s*int\(os\.environ\.get\('EMPLOYEE_TRACKER_CLOUD_UPLOAD_SECONDS',\s*'1'\)\)/, 'cloud uploads should default to every second, not every 5 seconds');
assert.match(config, /poll_interval_seconds\s*=\s*int\(os\.environ\.get\('EMPLOYEE_TRACKER_POLL_SECONDS',\s*'1'\)\)/, 'collector should default to one-second polling for near-immediate events');
assert.match(collector, /enqueue_cloud_payload\(/, 'collector should enqueue every captured activity payload immediately for durable upload');
assert.match(collector, /drain_queue\(connection\)/, 'collector should drain the durable upload queue in bounded batches');
assert.doesNotMatch(collector, /maybe_upload_activity\(activity_payload\)/, 'collector should not skip payloads due to upload throttling');
assert.match(screenshots, /timeout=5/, 'screenshot capture subprocesses must have timeouts so telemetry cannot hang behind screenshots');
assert.match(installer, /EMPLOYEE_TRACKER_POLL_SECONDS=1/, 'fresh installs should configure one-second polling');
assert.match(installer, /EMPLOYEE_TRACKER_CLOUD_UPLOAD_SECONDS=1/, 'fresh installs should configure one-second cloud upload');
