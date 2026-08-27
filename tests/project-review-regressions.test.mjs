import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

test('migration 007 adds creator semantics and payload-bound durable scoped creation idempotency', () => {
  assert.ok(existsSync(new URL('migrations/007_project_creation_integrity.sql', root)));
  const sql = read('migrations/007_project_creation_integrity.sql');
  assert.match(sql, /membership_type[\s\S]*creator/i);
  assert.match(sql, /add column if not exists creation_request_key uuid/i);
  assert.match(sql, /add column if not exists creation_requested_by bigint/i);
  assert.match(sql, /add column if not exists creation_payload_fingerprint text/i);
  assert.match(sql, /creation_payload_fingerprint[\s\S]*(?:check|constraint)[\s\S]*(?:64|\{64\})/i);
  assert.match(sql, /unique[\s\S]*creation_requested_by[\s\S]*creation_request_key|unique index[\s\S]*creation_requested_by[\s\S]*creation_request_key/i);
});

test('schema migration never heuristically activates pending memberships', () => {
  const sql = read('migrations/007_project_creation_integrity.sql');
  const db = read('lib/db.ts');
  assert.doesNotMatch(sql, /update\s+project_memberships[\s\S]*membership_status\s*=\s*'active'/i);
  assert.doesNotMatch(db, /set\s+membership_status\s*=\s*'active'/i);
});

test('ensureSchema mirrors migration 007 for upgraded and fresh databases', () => {
  const db = read('lib/db.ts');
  assert.match(db, /membership_type in \('invitation','request','creator'\)/i);
  assert.match(db, /creation_request_key uuid/i);
  assert.match(db, /creation_requested_by bigint/i);
  assert.match(db, /creation_payload_fingerprint text/i);
  assert.doesNotMatch(db, /set\s+membership_status\s*=\s*'active'/i);
});

test('agent submit is single-flight, draft-safe, keyboard accessible, and follows new content', () => {
  const ui = read('app/projects/[projectId]/WorkspaceClient.tsx');
  assert.match(ui, /submissionPendingRef\.current/, 'a ref must synchronously close the duplicate-submit race');
  assert.match(ui, /if\s*\(submissionPendingRef\.current\)\s*return/);
  assert.match(ui, /submissionPendingRef\.current\s*=\s*true/);
  assert.match(ui, /finally[\s\S]*submissionPendingRef\.current\s*=\s*false/);
  assert.match(ui, /const\s+pendingId\s*=\s*`pending-/);
  assert.match(ui, /setMessages\(\(current\)\s*=>\s*\[\.\.\.current,\s*pendingMessage\]\)/, 'the sent message must appear optimistically');
  assert.match(ui, /setAgentCommand\(\(current\)\s*=>\s*current\s*===\s*submittedDraft\s*\?\s*''\s*:\s*current\)/, 'submission must clear the exact pasted draft immediately');
  assert.match(ui, /filter\(\(message\)\s*=>\s*message\.id\s*!==\s*pendingId\)/, 'success or failure must reconcile the optimistic message');
  assert.match(ui, /setAgentCommand\(\(current\)\s*=>\s*current\s*\?\s*current\s*:\s*submittedDraft\)/, 'a failed send must restore the exact draft without overwriting newer input');
  assert.match(ui, /loadFiles\(\)\.catch/, 'a document refresh failure must not turn a successful chat into a failed send');
  assert.match(ui, /chatError[\s\S]*role="alert"/, 'chat errors must be visible beside the composer');
  assert.match(ui, />Message the project agent</);
  assert.match(ui, /Sending…/);
  assert.match(ui, /\?\s*'Sending…'\s*:\s*'Send'/);
  assert.doesNotMatch(ui, />Run command<|>Command the project agent<|>Starter commands</, 'chat UI must use familiar prompt/message terminology');
  assert.match(ui, /textarea[\s\S]*disabled=\{[^}]*agent/i);
  assert.match(ui, /aria-busy=\{[^}]*agent/i);
  assert.match(ui, /shiftKey/, 'Shift+Enter must remain a newline');
  assert.match(ui, /requestSubmit\(\)/, 'plain Enter must submit through the form');
  assert.match(ui, /conversationEndRef/);
  assert.match(ui, /scrollIntoView/);
  assert.match(ui, /useEffect\(\(\)\s*=>[\s\S]*conversationEndRef[\s\S]*\[messages,\s*actions,\s*receipts\]/);
});

test('agent work and file mutations expose visible accessible progress', () => {
  const [ui, css] = [read('app/projects/[projectId]/WorkspaceClient.tsx'), read('app/globals.css')];
  assert.match(ui, /busy\s*===\s*'agent'[\s\S]*agentWorking[\s\S]*Project agent is working/, 'the conversation must show an immediate agent working bubble');
  assert.match(ui, /className="typingDots"[\s\S]*aria-hidden="true"/, 'the working bubble needs a familiar visible typing treatment');
  assert.match(ui, /const\s+fileActivity\s*=\s*busy\s*===\s*'agent'[\s\S]*Updating files/, 'file activity must distinguish agent review from confirmed mutation');
  assert.match(ui, /aria-busy=\{Boolean\(fileActivity\)\}/, 'the files panel must expose busy state semantically');
  assert.match(ui, /fileLoadingState[\s\S]*loadingSpinner[\s\S]*fileActivity/, 'the files panel must show a visible loading indicator and status');
  assert.match(ui, /`confirm:\$\{action\.id\}`/, 'confirmed changes must own a file-mutation busy state');
  assert.match(ui, /`cancel:\$\{action\.id\}`/, 'cancellation must remain distinct from file mutation');
  assert.match(css, /\.typingDots[\s\S]*animation/);
  assert.match(css, /\.loadingSpinner[\s\S]*animation/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation:\s*none/);
});

test('agent file receipts use a defined success color and distinguish created output', () => {
  const [ui, css] = [read('app/projects/[projectId]/WorkspaceClient.tsx'), read('app/globals.css')];
  assert.match(css, /--green\s*:/);
  assert.match(css, /\.fileReceipt[\s\S]*var\(--green\)/);
  assert.match(ui, /action\.action_type\s*!==\s*'create_file'/);
  assert.match(ui, /label:\s*'File created'/);
});

test('project UI and services contain no Supabase client imports', () => {
  for (const path of ['app/projects/ProjectsClient.tsx', 'app/projects/[projectId]/WorkspaceClient.tsx', 'lib/projects.ts', 'lib/project-chat.ts']) {
    assert.doesNotMatch(read(path), /from\s+['"][^'"]*supabase|@supabase\//i, path);
  }
});
