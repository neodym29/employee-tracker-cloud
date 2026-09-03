import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const source = (path) => readFileSync(new URL(path, root), 'utf8');
function load(path) {
  assert.ok(existsSync(new URL(path, root)), `${path} must exist`);
  const js = ts.transpileModule(source(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, URL }, { filename: path });
  return module.exports;
}

test('canonicalizes equivalent credential-free Git remotes to one exact key', () => {
  const { parseGitRemote, canonicalRepositoryKey } = load('lib/git-remote.ts');
  const expected = 'github.com/Acme/widget';
  for (const remote of ['https://GitHub.COM/Acme/widget.git', 'https://github.com:443/Acme/widget/', 'ssh://git@github.com/Acme/widget.git', 'ssh://git@github.com:22/Acme/widget', 'git@github.com:Acme/widget.git']) {
    assert.equal(parseGitRemote(remote).repositoryKey, expected, remote);
    assert.equal(canonicalRepositoryKey(remote), expected, remote);
  }
  assert.equal(parseGitRemote('git@github.com:Acme/widget.git').remoteUrl, 'ssh://git@github.com/Acme/widget.git');
});

test('rejects unsafe, local, ambiguous, traversal, credential and secret-shaped remotes', () => {
  const { parseGitRemote } = load('lib/git-remote.ts');
  const secretQueryRemote = `https://github.com/acme/repo?${['to', 'ken=x'].join('')}`;
  const secretCredentialRemote = `https://${['ghp', 'unsafe'].join('_')}@github.com/acme/repo`;
  for (const value of ['', '.', '../repo', '/srv/repo', 'C:\\repo', 'file:///tmp/repo', 'https://github.com', 'https://github.com/acme', 'https://github.com/acme/../repo', secretQueryRemote, 'https://github.com/acme/repo#x', 'https://user@github.com/acme/repo', secretCredentialRemote, 'ftp://github.com/acme/repo', 'https://github.com/acme/repo\ninvalid']) assert.throws(() => parseGitRemote(value), value);
});

test('SCP remotes require a strict DNS or IPv4 host', () => {
  const { parseGitRemote } = load('lib/git-remote.ts');
  const rejected = [
    'git@foo@bar:owner/repo.git',
    'git@evil\\host:owner/repo.git',
    'git@bad host:owner/repo.git',
    'git@bad\thost:owner/repo.git',
    'git@github..com:owner/repo.git',
    'git@.github.com:owner/repo.git',
    'git@github.com.:owner/repo.git',
    'git@-github.com:owner/repo.git',
    'git@github-.com:owner/repo.git',
    'git@foo.-bar.com:owner/repo.git',
    'git@foo_bar.com:owner/repo.git',
    `git@${'a'.repeat(64)}.com:owner/repo.git`,
    `git@${`${'a'.repeat(63)}.`.repeat(4)}com:owner/repo.git`,
    'git@256.1.1.1:owner/repo.git',
    'git@1.2.3:owner/repo.git',
    'git@[2001:db8::1]:owner/repo.git',
  ];
  for (const remote of rejected) assert.throws(() => parseGitRemote(remote), remote);
  for (const remote of ['git@github.com:owner/repo.git', 'git@code.example.com:team/repo', 'git@192.0.2.10:owner/repo.git', 'ssh://git@[2001:db8::1]/owner/repo.git']) {
    assert.doesNotThrow(() => parseGitRemote(remote), remote);
  }
});

test('HTTPS parser rejects obvious forge web pages and requires .git for unknown hosts', () => {
  const { parseGitRemote } = load('lib/git-remote.ts');
  const rejected = ['https://github.com/acme/repo/issues', 'https://github.com/acme/repo/tree/main', 'https://bitbucket.org/acme/repo/pull-requests/1', 'https://gitlab.com/group/repo/-/issues/1', 'https://gitlab.com/group/repo/issues', 'https://gitlab.com/group/repo/merge_requests/1', 'https://code.example.com/team/repo'];
  for (const remote of rejected) assert.throws(() => parseGitRemote(remote), remote);
  for (const remote of ['https://github.com/acme/repo.git', 'https://bitbucket.org/acme/repo', 'https://gitlab.com/group/subgroup/repo.git', 'https://code.example.com/team/repo.git', 'git@code.example.com:team/repo', 'ssh://git@code.example.com/team/repo']) assert.doesNotThrow(() => parseGitRemote(remote), remote);
});

test('legacy Git attach is same-origin, owner/admin only and atomically attach-once', () => {
  const projects = source('lib/projects.ts');
  const route = source('app/api/projects/[projectId]/route.ts');
  const ui = source('app/projects/[projectId]/WorkspaceClient.tsx');
  assert.match(projects, /attachProjectGitRemote/);
  assert.match(projects, /role\s*===\s*'admin'[\s\S]*account_type\s*===\s*'admin'/);
  assert.match(projects, /git_remote_url\s+is\s+null[\s\S]*git_repository_key\s+is\s+null/i);
  assert.match(projects, /already has a Git remote/i);
  assert.match(route, /assertSameOrigin/);
  assert.match(route, /attachProjectGitRemote/);
  assert.doesNotMatch(route, /requireApiSession\('client'\)/);
  assert.match(ui, /Attach Git remote/);
  assert.match(ui, /canManageTraceMini\s*&&\s*!project\.gitRemote/);
  assert.match(ui, /gitRemote[\s\S]*loadWorkspace/);
});

test('project creation fingerprints and transactionally persists normalized Git link', () => {
  const projects = source('lib/projects.ts');
  assert.match(projects, /gitRemote/);
  assert.match(projects, /git_remote_url/);
  assert.match(projects, /git_repository_key/);
  assert.match(projects, /creationFingerprint\([\s\S]*git/i);
  assert.match(projects, /insert into projects\([^)]*git_remote_url[^)]*git_repository_key/i);
  assert.match(projects, /select[^;]*git_remote_url[^;]*git_repository_key/i);
  const ui = source('app/projects/ProjectsClient.tsx');
  assert.match(ui, /Git remote/i);
  assert.match(ui, /gitRemote/);
});

test('migration 018 is expand-only and safely preserves legacy writers and paired Git links', () => {
  const sql = source('migrations/018_project_git_link_and_tracemini_evidence.sql');
  const runtime = source('lib/db.ts');
  assert.match(sql, /add column if not exists git_remote_url text/i);
  assert.match(sql, /add column if not exists git_repository_key text/i);
  assert.match(sql, /git_remote_url is null and git_repository_key is null[\s\S]*git_remote_url is not null and git_repository_key is not null/i);
  assert.doesNotMatch(sql, /require_new_project_git_link|before insert on projects/i);
  assert.doesNotMatch(runtime, /create trigger require_new_project_git_link_before_insert/i);
  assert.match(runtime, /drop trigger if exists require_new_project_git_link_before_insert/i, 'runtime compatibility removes the unsafe trigger if an earlier build installed it');
  assert.match(sql, /project_tracemini_repository_matches[\s\S]*on delete cascade/i);
  assert.match(sql, /project_tracemini_evidence[\s\S]*evidence_key[\s\S]*primary key/i);
  assert.match(sql, /immutable/i);
  assert.doesNotMatch(sql, /update projects set git_remote/i);
  assert.match(runtime, /project_tracemini_repository_matches/);
});

test('open-project discovery redacts Git metadata until the engineer is active', () => {
  const projects = source('lib/projects.ts');
  const ui = source('app/projects/ProjectsClient.tsx');
  assert.match(projects, /case\s+when\s+pm\.membership_status='active'\s+then\s+p\.git_remote_url\s+else\s+null\s+end\s+as\s+git_remote_url/i);
  assert.match(projects, /case\s+when\s+pm\.membership_status='active'\s+then\s+p\.git_repository_key\s+else\s+null\s+end\s+as\s+git_repository_key/i);
  assert.match(ui, /accountType\s*===\s*'client'\s*\|\|\s*project\.membership_status\s*===\s*'active'[\s\S]*Git remote:/i);
  assert.match(projects, /getProject[\s\S]*projectAccessSql[\s\S]*git_remote_url[\s\S]*git_repository_key/i);
});
