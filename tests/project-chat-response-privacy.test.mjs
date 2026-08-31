import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const url = (path) => new URL(`../${path}`, import.meta.url);
const dtoPath = 'lib/project-chat-dto.ts';

function loadDto() {
  assert.ok(existsSync(url(dtoPath)), 'public project-chat DTO serializer must exist');
  const source = readFileSync(url(dtoPath), 'utf8');
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, { module, exports: module.exports, require() { throw new Error('DTO serializer must not import runtime dependencies'); } });
  return module.exports;
}

test('public agent action DTO strips paths, content, and internal payloads', () => {
  const { toPublicAgentAction } = loadDto();
  const value = toPublicAgentAction({
    id: 17,
    action_type: 'update_file',
    status: 'pending',
    created_at: new Date('2026-08-31T00:00:00.000Z'),
    input: { path: 'private/report.md', content: 'secret input' },
    output: { content: 'secret output' },
    result: { path: 'private/report.md', sha256: 'hidden' },
    actor_user_id: 42,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(value)), {
    id: '17',
    action_type: 'update_file',
    status: 'pending',
    created_at: '2026-08-31T00:00:00.000Z',
  });
  assert.doesNotMatch(JSON.stringify(value), /private|secret|path|content|input|output|result|sha256|actor/i);
});

test('chat and action routes apply the public DTO at every browser response boundary', () => {
  const routePaths = [
    'app/api/projects/[projectId]/chat/route.ts',
    'app/api/projects/[projectId]/agent-actions/[actionId]/route.ts',
    'app/api/projects/[projectId]/agent-actions/[actionId]/confirm/route.ts',
    'app/api/projects/[projectId]/agent-actions/[actionId]/cancel/route.ts',
  ];
  const routes = routePaths.map((path) => readFileSync(url(path), 'utf8'));
  for (const route of routes) assert.match(route, /toPublicAgentAction/);
  assert.match(routes[0], /actions:\s*[^,;]*\.map\(toPublicAgentAction\)/);
  assert.doesNotMatch(routes.join('\n'), /action:\s*await\s+(?:confirm|cancel)ProjectAgentAction/);
  const service = readFileSync(url('lib/project-chat.ts'), 'utf8');
  assert.match(service, /returning id,action_type,input,status,confirmed_by,confirmed_at,result,created_at/);
  assert.match(service, /returning a\.id,a\.action_type,a\.status,a\.confirmed_by,a\.confirmed_at,a\.result,a\.created_at/);
});
