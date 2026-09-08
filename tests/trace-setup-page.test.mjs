import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
const read = p => readFileSync(p, 'utf8');
const route = 'app/trace-setup/page.tsx';
test('setup is a dedicated approved-session route using shared chrome and components', async () => {
  assert.ok(existsSync(route), 'dedicated /trace-setup route exists');
  const source = read(route);
  assert.match(source, /force-dynamic/);
  assert.match(source, /dashboardShell/);
  assert.match(source, /href="\/projects">Back to projects/);
  assert.equal((source.match(/<DesktopCliConnection\s*\/>/g) || []).length, 1);
  assert.doesNotMatch(source, /<TraceNodeInstall|<Discovery|<form|fetch\(/);
  const module = {exports:{}};
  let allowed = false, checks = 0;
  const denied = new Error('redirect login');
  const jsx = (type, props) => ({type, props});
  vm.runInNewContext(ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText, {
    module, exports:module.exports, require: p => p === '@/lib/auth' ? {requireApprovedSession:async()=>{checks++;if(!allowed)throw denied;return {account_type:'client'};}} : p === 'react/jsx-runtime' ? {jsx,jsxs:jsx} : {default:'DesktopCliConnection',__esModule:true}
  });
  await assert.rejects(module.exports.default(), e=>e===denied);
  allowed = true;
  assert.ok(await module.exports.default());
  assert.equal(checks,2);
});
test('Projects links to setup without inline setup or coupling project creation to enrollment', () => {
  const source = read('app/projects/ProjectsClient.tsx');
  assert.match(source, /href="\/trace-setup">Set up Trace CLI/);
  assert.doesNotMatch(source, /DesktopCliConnection|traceSetupOpen|createdProjectId|<Discovery|<TraceNodeInstall/);
  assert.match(source, /router.push\(`\/projects\/\$\{data.project.id\}`\)/);
  assert.match(source, /Open workspace/);
});
test('setup is discoverable through persistent active app navigation', () => {
  assert.match(read('app/layout.tsx'), /<ActiveNavLink className="traceSetupNavLink" href="\/trace-setup">Set up Trace CLI<\/ActiveNavLink>/);
  const css = read('app/globals.css').split('@media (max-width: 720px)')[1];
  assert.match(css, /\.traceSetupNavLink[^}]*display:\s*inline-flex/);
  assert.match(css, /\.navActions\s*\{[^}]*flex-wrap:\s*wrap/);
});
