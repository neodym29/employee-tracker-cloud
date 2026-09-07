import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
function harness(respond, entry = 'RepositorySelection') {
  const slots = []; let cursor = 0; const effects = []; const calls = [];
  const jsx = (type, props) => ({type, props});
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= {current: initial}; },
    useCallback(fn) { return fn; },
    useEffect(fn) { effects.push(fn); },
    useId() { return 'tip'; },
  };
  const load = file => {
    const module = {exports: {}};
    vm.runInNewContext(ts.transpileModule(read(`app/components/trace-node/${file}`), {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX}}).outputText, {
      module, exports: module.exports, Date, console, setInterval: () => 1, clearInterval() {},
      fetch: async (url, options) => { calls.push({url, options}); const data = await respond(url, options); return {ok: data.ok !== false, status: data.status || 200, json: async () => data}; },
      require: p => p === 'react' ? hooks : p === 'react/jsx-runtime' ? {jsx, jsxs: jsx} : p === './repository-selection' ? load('repository-selection.ts') : {__esModule: true, default: 'RepositorySelection'},
    });
    return module.exports;
  };
  const component = load(`${entry}.tsx`).default;
  return {calls, render(props = {}) {cursor = 0; effects.length = 0; return component(props);}, async mount() { for (const effect of effects) effect(); await new Promise(r => setImmediate(r)); }};
}
function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)]; }
function button(tree, label) { return nodes(tree).find(n => n.type === 'button' && [n.props.children].flat().join('') === label); }
const switches = tree => nodes(tree).filter(n => n.props?.role === 'switch');
const agent = {id:1, user_id:5, status:'online'};
const candidate = {id:7, agent_id:1, owner_user_id:5, name:'Widget', machine_name:'Laptop', normalized_remote:'github.com/acme/widget', project_id:'99', selectable:true, traced:false, desired_traced:false, revision:3};
const props = (c = candidate, agents = [agent]) => ({workspaceId:0, userId:5, agents, candidates:[c], reload:async()=>{}});

test('Trace setup belongs to both creation cards, never below ProjectsClient', () => {
  assert.doesNotMatch(read('app/projects/page.tsx'), /<TraceMiniProjectDiscovery|<DesktopCliConnection/);
  const ui = read('app/projects/ProjectsClient.tsx');
  assert.match(ui, /<DesktopCliConnection/);
  assert.doesNotMatch(ui, /<TraceMiniProjectDiscovery/);
  assert.match(read('app/components/DesktopCliConnection.tsx'), /<Discovery\s*\/>/);
  assert.equal((ui.match(/\{traceSetup\}/g) || []).length, 2);
  assert.match(ui, /if \(traceSetupOpen\)/);
  assert.match(ui, /setCreatedProjectId\(data.project.id\)/);
});

test('discovered repositories remain unselected without an explicit switch action', () => {
  const h = harness(() => ({}));
  const tree = h.render(props());
  assert.equal(switches(tree)[0].props.checked, false);
  assert.equal(switches(tree)[0].props.disabled, false);
  assert.equal(h.calls.length, 0);
});

test('tracking requires own uniquely authorized project mapping and sends CAS revision', async () => {
  const h = harness(() => ({}));
  for (const c of [{...candidate,selectable:false,project_id:undefined}, {...candidate,owner_user_id:6}]) {
    assert.equal(switches(h.render(props(c)))[0].props.disabled, true);
  }
  await switches(h.render(props()))[0].props.onChange({target:{checked:true}});
  assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  assert.equal(call.url, '/api/agents/discovery');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(call.options.body), {action:'select',candidateId:'7',traced:true,revision:3});
  assert.equal(switches(h.render(props()))[0].props.checked, false, 'mutation response alone cannot confirm tracing');
  const pending = h.render(props({...candidate,desired_traced:true}));
  assert.match(JSON.stringify(pending), /Starting trace on device/);
  assert.equal(switches(pending)[0].props.disabled, true);
});

test('server confirmation and stop acknowledgement are distinct states', async () => {
  const h = harness(() => ({}));
  const tree = h.render(props({...candidate,traced:true,desired_traced:true}));
  assert.match(JSON.stringify(tree), /Traced/);
  await switches(tree)[0].props.onChange({target:{checked:false}});
  assert.deepEqual(JSON.parse(h.calls[0].options.body), {action:'select',candidateId:'7',traced:false,revision:3});
  const pending = h.render(props({...candidate,traced:true,desired_traced:false}));
  assert.match(JSON.stringify(pending), /Stopping trace on device/);
  assert.equal(switches(pending)[0].props.disabled, true);
});

test('failed Node status refresh clears stale candidates and locks scans', async () => {
  let fail = false;
  const h = harness(() => fail ? {ok:false} : {userId:5,agents:[agent],candidates:[candidate]}, 'Discovery');
  h.render(); await h.mount();
  assert.match(JSON.stringify(h.render()), /Node CLI is polling/);
  fail = true;
  button(h.render(), 'Refresh Node status').props.onClick();
  await new Promise(r => setImmediate(r));
  const tree = h.render();
  assert.match(JSON.stringify(tree), /Node discovery unavailable. Refresh to retry/);
  const selection = nodes(tree).find(n => n.type === 'RepositorySelection');
  assert.equal(selection.props.candidates.length, 0);
  const child = harness(() => ({}));
  assert.equal(button(child.render(selection.props), 'Scan repositories on my devices').props.disabled, true);
});

test('local-only or ambiguous repositories without server authorization cannot start tracking', () => {
  const h = harness(() => ({}));
  const tree = h.render(props({...candidate,normalized_remote:'local:abc',selectable:false,project_id:undefined}));
  assert.equal(switches(tree)[0].props.disabled, true);
  assert.match(JSON.stringify(tree), /No unique authorized project match/);
  assert.equal(h.calls.length, 0);
});

test('matched repositories open existing projects without duplicate creation or ZIP upload', () => {
  const h = harness(() => ({}));
  const tree = h.render(props());
  assert.ok(nodes(tree).some(n => n.type === 'a' && n.props.href === '/projects/99' && n.props.children === 'Open existing project'));
  assert.equal(h.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(tree), /ZIP|type.*file|Create project/i);
  assert.doesNotMatch(read('app/components/trace-node/RepositorySelection.tsx'), /candidate\.(local_key|normalized_remote)/);
});

test('offline or other-account Nodes cannot scan; explicit scan only targets own live Nodes', async () => {
  const h = harness(() => ({id:12,status:'queued'}));
  for (const agents of [[{...agent,status:'offline'}], [{...agent,user_id:6}]]) {
    const tree = h.render(props(candidate, agents));
    assert.equal(button(tree, 'Scan repositories on my devices').props.disabled, true);
    assert.match(JSON.stringify(tree), /Install or reconnect/);
  }
  assert.equal(h.calls.length, 0);
  await button(h.render(props(candidate,[agent,{...agent,id:2,user_id:6}])), 'Scan repositories on my devices').props.onClick();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(JSON.parse(h.calls[0].options.body), {action:'scan',nodeId:1});
  assert.match(JSON.stringify(h.render(props())), /Waiting for an authenticated Node poll/);
});

test('stale selection conflicts are actionable and never claim tracing', async () => {
  const h = harness(() => ({ok:false,status:409}));
  await switches(h.render(props()))[0].props.onChange({target:{checked:true}});
  const tree = h.render(props());
  assert.match(JSON.stringify(tree), /State changed or Node is offline. Refresh and retry/);
  assert.equal(switches(tree)[0].props.checked, false);
});
