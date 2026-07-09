import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cloud = readFileSync(new URL('../agent/src/employee_tracker/cloud.py', import.meta.url), 'utf8');
const config = readFileSync(new URL('../agent/src/employee_tracker/config.py', import.meta.url), 'utf8');
const collector = readFileSync(new URL('../agent/src/employee_tracker/collector.py', import.meta.url), 'utf8');
const screenshots = readFileSync(new URL('../agent/src/employee_tracker/screenshots.py', import.meta.url), 'utf8');
const installer = readFileSync(new URL('../app/api/installer/route.ts', import.meta.url), 'utf8');

assert.match(cloud, /upload_interval\s*=\s*int\(os\.environ\.get\('EMPLOYEE_TRACKER_CLOUD_UPLOAD_SECONDS',\s*'5'\)\)/, 'cloud uploads should default to a lightweight five-second cadence, not hammer every second');
assert.match(config, /poll_interval_seconds\s*=\s*int\(os\.environ\.get\('EMPLOYEE_TRACKER_POLL_SECONDS',\s*'2'\)\)/, 'collector should default to two-second polling for low PC impact');
assert.match(config, /EMPLOYEE_TRACKER_FILE_SCAN_SECONDS',\s*'120'/, 'file scans should default to a low-impact cadence');
assert.match(config, /EMPLOYEE_TRACKER_PROCESS_SCAN_SECONDS',\s*'60'/, 'process scans should default to a low-impact cadence');
assert.match(config, /EMPLOYEE_TRACKER_STATE_SNAPSHOT_SECONDS',\s*'10'/, 'expensive window/tab/open-state snapshots should be throttled separately');
assert.match(config, /EMPLOYEE_TRACKER_ENABLE_FILE_CONTENT',\s*'0'/, 'file-content reads should be opt-in for low PC impact');
assert.match(cloud, /EMPLOYEE_TRACKER_MAX_UPLOAD_QUEUE_ROWS',\s*'5000'/, 'local upload queue should stay bounded by default');
assert.match(cloud, /64 \* 1024 \* 1024/, 'local upload queue bytes should stay bounded by default');
assert.match(collector, /state_snapshot_interval_seconds/, 'collector should have a separate cadence for expensive state snapshots');
assert.match(collector, /_cached_open_state/, 'collector should reuse cached open-state between snapshot ticks');
assert.match(collector, /enqueue_cloud_payload\(/, 'collector should still enqueue captured activity payloads durably');
assert.match(collector, /drain_queue\(connection\)/, 'collector should still drain the durable upload queue in bounded batches');
assert.doesNotMatch(collector, /maybe_upload_activity\(activity_payload\)/, 'collector should not use the old non-durable maybe-upload path');
assert.match(screenshots, /timeout=5/, 'screenshot capture subprocesses must have timeouts so telemetry cannot hang behind screenshots');
assert.match(installer, /EMPLOYEE_TRACKER_POLL_SECONDS=2/, 'fresh installs should configure low-impact polling');
assert.match(installer, /EMPLOYEE_TRACKER_CLOUD_UPLOAD_SECONDS=5/, 'fresh installs should configure low-impact cloud upload');
assert.match(installer, /EMPLOYEE_TRACKER_ENABLE_FILE_CONTENT=0/, 'fresh installs should avoid reading file contents by default');
assert.match(installer, /EMPLOYEE_TRACKER_STATE_SNAPSHOT_SECONDS=10/, 'fresh installs should throttle expensive open-state snapshots');
