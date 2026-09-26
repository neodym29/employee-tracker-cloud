import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: [new URL('../lib/message-alerts.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', platform: 'node', write: false,
});
const alerts = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('message alerts require an explicit opt-in and avoid duplicate notifications', async () => {
  const values = new Map();
  const shown = [];
  let opened = '';
  globalThis.window = {
    localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    location: { pathname: '/projects', assign: path => { opened = path; } },
    focus() {},
  };
  globalThis.document = { visibilityState: 'hidden' };
  globalThis.Notification = class {
    static permission = 'granted';
    static async requestPermission() { return 'granted'; }
    constructor(title, options) { this.title = title; this.options = options; shown.push(this); }
    close() {}
  };
  window.Notification = globalThis.Notification;
  const chat = { id: '42', name: 'Team', latestAt: '2026-09-26T10:00:00.000Z' };
  alerts.notifyNewMessage(chat);
  assert.equal(shown.length, 0);
  assert.equal(await alerts.enableAlerts(), 'enabled');
  alerts.notifyNewMessage(chat);
  alerts.notifyNewMessage(chat);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'New message · Team');
  assert.equal(shown[0].options.body, 'Open Neo-Nexus to view.');
  shown[0].onclick();
  assert.equal(opened, '/chats?conversation=42');
  alerts.notifyNewClientRequest({ id: '7', projectId: '12', summary: 'Sensitive request', createdAt: '2026-09-26T10:01:00.000Z' });
  assert.equal(shown.length, 2);
  assert.equal(shown[1].title, 'New project request');
  assert.doesNotMatch(shown[1].options.body, /Sensitive/);
  alerts.disableAlerts();
  alerts.notifyNewMessage({ ...chat, latestAt: '2026-09-26T10:02:00.000Z' });
  assert.equal(shown.length, 2);
});
